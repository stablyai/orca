import { FrameDecoder, MessageType, encodeJsonRpcFrame, encodeKeepAliveFrame, parseJsonRpcMessage, KEEPALIVE_SEND_MS } from './protocol';
export class RelayDispatcher {
    decoder;
    write;
    requestHandlers = new Map();
    notificationHandlers = new Map();
    nextOutgoingSeq = 1;
    highestReceivedSeq = 0;
    keepaliveTimer = null;
    disposed = false;
    constructor(write) {
        this.write = write;
        this.decoder = new FrameDecoder((frame) => this.handleFrame(frame));
        this.startKeepalive();
    }
    onRequest(method, handler) {
        this.requestHandlers.set(method, handler);
    }
    onNotification(method, handler) {
        this.notificationHandlers.set(method, handler);
    }
    feed(data) {
        if (this.disposed) {
            return;
        }
        try {
            this.decoder.feed(data);
        }
        catch (err) {
            process.stderr.write(`[relay] Protocol error: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    notify(method, params) {
        if (this.disposed) {
            return;
        }
        const msg = {
            jsonrpc: '2.0',
            method,
            ...(params !== undefined ? { params } : {})
        };
        this.sendFrame(msg);
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }
    handleFrame(frame) {
        if (frame.id > this.highestReceivedSeq) {
            this.highestReceivedSeq = frame.id;
        }
        if (frame.type === MessageType.KeepAlive) {
            return;
        }
        if (frame.type === MessageType.Regular) {
            try {
                const msg = parseJsonRpcMessage(frame.payload);
                this.handleMessage(msg);
            }
            catch (err) {
                process.stderr.write(`[relay] Parse error: ${err instanceof Error ? err.message : String(err)}\n`);
            }
        }
    }
    handleMessage(msg) {
        if ('id' in msg && 'method' in msg) {
            void this.handleRequest(msg);
        }
        else if ('method' in msg && !('id' in msg)) {
            this.handleNotification(msg);
        }
    }
    async handleRequest(req) {
        const handler = this.requestHandlers.get(req.method);
        if (!handler) {
            this.sendResponse(req.id, undefined, {
                code: -32601,
                message: `Method not found: ${req.method}`
            });
            return;
        }
        try {
            const result = await handler(req.params ?? {});
            this.sendResponse(req.id, result);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = err.code ?? -32000;
            this.sendResponse(req.id, undefined, { code, message });
        }
    }
    handleNotification(notif) {
        const handler = this.notificationHandlers.get(notif.method);
        if (handler) {
            handler(notif.params ?? {});
        }
    }
    sendResponse(id, result, error) {
        const msg = {
            jsonrpc: '2.0',
            id,
            ...(error ? { error } : { result: result ?? null })
        };
        this.sendFrame(msg);
    }
    sendFrame(msg) {
        if (this.disposed) {
            return;
        }
        const seq = this.nextOutgoingSeq++;
        const frame = encodeJsonRpcFrame(msg, seq, this.highestReceivedSeq);
        this.write(frame);
    }
    startKeepalive() {
        this.keepaliveTimer = setInterval(() => {
            if (this.disposed) {
                return;
            }
            const seq = this.nextOutgoingSeq++;
            const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq);
            this.write(frame);
        }, KEEPALIVE_SEND_MS);
        // Why: without unref, the keepalive interval keeps the event loop alive
        // even when the relay should be winding down (e.g. after stdin ends and
        // all PTYs have exited). unref lets the process exit naturally.
        this.keepaliveTimer.unref();
    }
}
