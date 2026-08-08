const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 6060);
const CLIENT_FILE = path.join(__dirname, "client.html");

const connections = new Map();

function getToken(req) {
    const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
    );

    if (url.search.startsWith("?=")) {
        const value = url.search.slice(2);

        return decodeURIComponent(
            value.split("&")[0]
        ).trim();
    }

    return (
        url.searchParams.get("token") || ""
    ).trim();
}

function sendJSON(ws, data) {
    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {
        try {
            ws.send(JSON.stringify(data));
        } catch (error) {
        }
    }
}

function viewerCount(connection) {
    return connection.clients.size;
}

function notifyAgentViewerCount(connection) {
    if (
        connection.agent &&
        connection.agent.readyState === WebSocket.OPEN
    ) {
        sendJSON(
            connection.agent,
            {
                type: "viewer_count",
                count: viewerCount(connection)
            }
        );
    }
}

function sendClient(res) {
    try {
        const html = fs.readFileSync(
            CLIENT_FILE
        );

        res.writeHead(200, {
            "Content-Type":
                "text/html; charset=utf-8",
            "Cache-Control":
                "no-store"
        });

        res.end(html);
    } catch (error) {
        res.writeHead(500, {
            "Content-Type":
                "application/json"
        });

        res.end(
            JSON.stringify({
                ok: false,
                error:
                    "client.html could not be loaded"
            })
        );
    }
}

function json(res, status, data) {
    res.writeHead(status, {
        "Content-Type":
            "application/json; charset=utf-8",
        "Cache-Control":
            "no-store",
        "Access-Control-Allow-Origin":
            "*"
    });

    res.end(
        JSON.stringify(data)
    );
}

function forwardAgentSignal(connection, message) {
    for (
        const client of connection.clients
    ) {
        if (
            client.readyState === WebSocket.OPEN
        ) {
            sendJSON(
                client,
                message
            );
        }
    }
}

function forwardClientSignal(connection, message) {
    if (
        connection.agent &&
        connection.agent.readyState === WebSocket.OPEN
    ) {
        sendJSON(
            connection.agent,
            message
        );
    }
}

const server = http.createServer(
    (req, res) => {
        const url = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        const token = getToken(req);

        if (req.method === "OPTIONS") {
            res.writeHead(204, {
                "Access-Control-Allow-Origin":
                    "*",
                "Access-Control-Allow-Methods":
                    "GET,POST,OPTIONS",
                "Access-Control-Allow-Headers":
                    "Content-Type"
            });

            res.end();
            return;
        }

        if (
            url.pathname === "/" ||
            url.pathname === "/connect" ||
            url.pathname === "/connect/"
        ) {
            sendClient(res);
            return;
        }

        if (
            url.pathname === "/create" ||
            url.pathname === "/create/"
        ) {
            if (!token) {
                json(
                    res,
                    400,
                    {
                        ok: false,
                        error:
                            "No token supplied."
                    }
                );

                return;
            }

            if (!connections.has(token)) {
                connections.set(
                    token,
                    {
                        token,
                        agent: null,
                        clients: new Set()
                    }
                );
            }

            json(
                res,
                200,
                {
                    ok: true,
                    token,
                    connectUrl:
                        `/connect/?=${encodeURIComponent(
                            token
                        )}`
                }
            );

            return;
        }

        if (
            url.pathname === "/connection" ||
            url.pathname === "/connection/"
        ) {
            const connection =
                connections.get(token);

            if (!connection) {
                json(
                    res,
                    404,
                    {
                        ok: false,
                        error:
                            "Connection does not exist."
                    }
                );

                return;
            }

            json(
                res,
                200,
                {
                    ok: true,
                    agentConnected:
                        !!connection.agent &&
                        connection.agent.readyState ===
                            WebSocket.OPEN,
                    viewers:
                        connection.clients.size
                }
            );

            return;
        }

        if (
            url.pathname === "/health" ||
            url.pathname === "/health/"
        ) {
            json(
                res,
                200,
                {
                    ok: true,
                    port: PORT,
                    connections:
                        connections.size
                }
            );

            return;
        }

        json(
            res,
            404,
            {
                ok: false,
                error: "Not found."
            }
        );
    }
);

const wss = new WebSocket.Server({
    noServer: true,
    maxPayload: 1024 * 1024
});

server.on(
    "upgrade",
    (req, socket, head) => {
        const url = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        const token = getToken(req);

        if (
            !token ||
            ![
                "/ws",
                "/connection",
                "/connection/"
            ].includes(
                url.pathname
            )
        ) {
            socket.write(
                "HTTP/1.1 404 Not Found\r\n" +
                "Connection: close\r\n" +
                "\r\n"
            );

            socket.destroy();
            return;
        }

        if (!connections.has(token)) {
            socket.write(
                "HTTP/1.1 404 Not Found\r\n" +
                "Connection: close\r\n" +
                "\r\n"
            );

            socket.destroy();
            return;
        }

        wss.handleUpgrade(
            req,
            socket,
            head,
            ws => {
                wss.emit(
                    "connection",
                    ws,
                    req
                );
            }
        );
    }
);

wss.on(
    "connection",
    (ws, req) => {
        const url = new URL(
            req.url,
            `http://${req.headers.host || "localhost"}`
        );

        const token = getToken(req);

        const role = (
            url.searchParams.get("role") ||
            "client"
        ).toLowerCase();

        const connection =
            connections.get(token);

        if (!connection) {
            ws.close(
                1008,
                "Connection does not exist."
            );

            return;
        }

        if (role === "agent") {
            if (
                connection.agent &&
                connection.agent.readyState ===
                    WebSocket.OPEN
            ) {
                connection.agent.close(
                    1000,
                    "Replaced by another agent."
                );
            }

            connection.agent = ws;

            sendJSON(
                ws,
                {
                    type:
                        "agent_connected"
                }
            );

            notifyAgentViewerCount(
                connection
            );

            ws.on(
                "message",
                (
                    data,
                    isBinary
                ) => {
                    if (isBinary) {
                        return;
                    }

                    let message;

                    try {
                        message =
                            JSON.parse(
                                data.toString()
                            );
                    } catch (error) {
                        return;
                    }

                    forwardAgentSignal(
                        connection,
                        message
                    );
                }
            );

            ws.on(
                "close",
                () => {
                    if (
                        connection.agent ===
                        ws
                    ) {
                        connection.agent =
                            null;
                    }

                    for (
                        const client of
                            connection.clients
                    ) {
                        sendJSON(
                            client,
                            {
                                type:
                                    "agent_status",
                                connected:
                                    false
                            }
                        );
                    }
                }
            );

            ws.on(
                "error",
                () => {}
            );

            return;
        }

        for (
            const existing of
                connection.clients
        ) {
            if (
                existing !== ws &&
                existing.readyState ===
                    WebSocket.OPEN
            ) {
                existing.close(
                    1000,
                    "Replaced by another client."
                );
            }
        }

        connection.clients.clear();
        connection.clients.add(ws);

        sendJSON(
            ws,
            {
                type: "connected",
                agentConnected:
                    !!connection.agent &&
                    connection.agent.readyState ===
                        WebSocket.OPEN
            }
        );

        notifyAgentViewerCount(
            connection
        );

        ws.on(
            "message",
            (
                data,
                isBinary
            ) => {
                if (isBinary) {
                    return;
                }

                let message;

                try {
                    message =
                        JSON.parse(
                            data.toString()
                        );
                } catch (error) {
                    return;
                }

                forwardClientSignal(
                    connection,
                    message
                );
            }
        );

        ws.on(
            "close",
            () => {
                connection.clients.delete(
                    ws
                );

                notifyAgentViewerCount(
                    connection
                );
            }
        );

        ws.on(
            "error",
            () => {
                connection.clients.delete(
                    ws
                );

                notifyAgentViewerCount(
                    connection
                );
            }
        );
    }
);

server.on(
    "error",
    error => {
        console.error(
            "HTTP server error:",
            error
        );
    }
);

server.listen(
    PORT,
    HOST,
    () => {
        console.log(
            `Server running on :${PORT}`
        );
    }
);
