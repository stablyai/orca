import { createServer } from 'net';
import { randomUUID } from 'crypto';
import { writeFileSync, chmodSync, unlinkSync } from 'fs';
import { encodeNdjson, createNdjsonParser } from './ndjson';
import { TerminalHost } from './terminal-host';
import { PROTOCOL_VERSION, NOTIFY_PREFIX } from './types';
export class DaemonServer {
    server = null;
    token;
    host;
    socketPath;
    tokenPath;
    clients = new Map();
    constructor(opts) {
        this.socketPath = opts.socketPath;
        this.tokenPath = opts.tokenPath;
        this.token = randomUUID();
        this.host = new TerminalHost({ spawnSubprocess: opts.spawnSubprocess });
    }
    async start() {
        return new Promise((resolve, reject) => {
            this.server = createServer((socket) => this.handleConnection(socket));
            this.server.on('error', (err) => {
                reject(err);
            });
            this.server.listen(this.socketPath, () => {
                writeFileSync(this.tokenPath, this.token, { mode: 0o600 });
                try {
                    chmodSync(this.socketPath, 0o600);
                }
                catch {
                    // Best-effort on platforms that support it
                }
                resolve();
            });
        });
    }
    async shutdown() {
        this.host.dispose();
        for (const [, client] of this.clients) {
            client.controlSocket.destroy();
            client.streamSocket?.destroy();
        }
        this.clients.clear();
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    try {
                        unlinkSync(this.socketPath);
                    }
                    catch { }
                    resolve();
                });
                this.server = null;
            }
            else {
                resolve();
            }
        });
    }
    handleConnection(socket) {
        const parser = createNdjsonParser((msg) => this.handleFirstMessage(socket, msg, parser), () => {
            socket.destroy();
        });
        socket.on('data', (chunk) => parser.feed(chunk.toString()));
        socket.on('error', () => socket.destroy());
    }
    handleFirstMessage(socket, msg, _parser) {
        const hello = msg;
        if (hello.type !== 'hello') {
            socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }));
            socket.destroy();
            return;
        }
        if (hello.version !== PROTOCOL_VERSION) {
            socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Protocol version mismatch' }));
            socket.destroy();
            return;
        }
        if (hello.token !== this.token) {
            socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid token' }));
            socket.destroy();
            return;
        }
        socket.write(encodeNdjson({ type: 'hello', ok: true }));
        if (hello.role === 'control') {
            const client = {
                clientId: hello.clientId,
                controlSocket: socket,
                streamSocket: null
            };
            this.clients.set(hello.clientId, client);
            this.setupControlSocket(socket, hello.clientId);
        }
        else if (hello.role === 'stream') {
            const client = this.clients.get(hello.clientId);
            if (client) {
                client.streamSocket = socket;
            }
            // Stream socket is receive-only from daemon's perspective (for events)
        }
    }
    setupControlSocket(socket, clientId) {
        const parser = createNdjsonParser((msg) => this.handleRequest(socket, clientId, msg), () => { } // Ignore parse errors
        );
        // Remove the initial data listener and replace with the RPC parser
        socket.removeAllListeners('data');
        socket.on('data', (chunk) => parser.feed(chunk.toString()));
        socket.on('close', () => {
            this.clients.delete(clientId);
        });
    }
    async handleRequest(socket, clientId, request) {
        const isNotify = request.id.startsWith(NOTIFY_PREFIX);
        try {
            const result = await this.routeRequest(clientId, request);
            if (!isNotify) {
                socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }));
            }
        }
        catch (err) {
            if (!isNotify) {
                socket.write(encodeNdjson({
                    id: request.id,
                    ok: false,
                    error: err instanceof Error ? err.message : String(err)
                }));
            }
        }
    }
    async routeRequest(clientId, request) {
        const client = this.clients.get(clientId);
        switch (request.type) {
            case 'createOrAttach': {
                const p = request.payload;
                const result = await this.host.createOrAttach({
                    sessionId: p.sessionId,
                    cols: p.cols,
                    rows: p.rows,
                    cwd: p.cwd,
                    env: p.env,
                    command: p.command,
                    shellReadySupported: p.shellReadySupported,
                    streamClient: {
                        onData: (data) => {
                            if (client?.streamSocket) {
                                client.streamSocket.write(encodeNdjson({
                                    type: 'event',
                                    event: 'data',
                                    sessionId: p.sessionId,
                                    payload: { data }
                                }));
                            }
                        },
                        onExit: (code) => {
                            if (client?.streamSocket) {
                                client.streamSocket.write(encodeNdjson({
                                    type: 'event',
                                    event: 'exit',
                                    sessionId: p.sessionId,
                                    payload: { code }
                                }));
                            }
                        }
                    }
                });
                return {
                    isNew: result.isNew,
                    snapshot: result.snapshot,
                    pid: result.pid,
                    shellState: result.shellState
                };
            }
            case 'write':
                this.host.write(request.payload.sessionId, request.payload.data);
                return {};
            case 'resize':
                this.host.resize(request.payload.sessionId, request.payload.cols, request.payload.rows);
                return {};
            case 'kill':
                this.host.kill(request.payload.sessionId);
                return {};
            case 'signal':
                this.host.signal(request.payload.sessionId, request.payload.signal);
                return {};
            case 'detach':
                // Note: detach token handling is simplified here — full implementation
                // would track tokens per client
                return {};
            case 'getCwd':
                return { cwd: this.host.getCwd(request.payload.sessionId) };
            case 'clearScrollback':
                this.host.clearScrollback(request.payload.sessionId);
                return {};
            case 'listSessions':
                return { sessions: this.host.listSessions() };
            case 'shutdown':
                if (request.payload.killSessions) {
                    this.host.dispose();
                }
                process.nextTick(() => this.shutdown());
                return {};
            default:
                throw new Error(`Unknown request type: ${request.type}`);
        }
    }
}
