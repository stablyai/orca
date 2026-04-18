import { FrameDecoder, MessageType, encodeJsonRpcFrame, encodeKeepAliveFrame, parseJsonRpcMessage, KEEPALIVE_SEND_MS, TIMEOUT_MS } from './relay-protocol';
const REQUEST_TIMEOUT_MS = 30_000;
export class SshChannelMultiplexer {
    decoder;
    transport;
    nextRequestId = 1;
    nextOutgoingSeq = 1;
    highestReceivedSeq = 0;
    highestAckedBySelf = 0;
    lastReceivedAt = Date.now();
    pendingRequests = new Map();
    notificationHandlers = [];
    keepaliveTimer = null;
    timeoutTimer = null;
    disposed = false;
    // Track the oldest unacked outgoing message timestamp
    unackedTimestamps = new Map();
    constructor(transport) {
        this.transport = transport;
        this.decoder = new FrameDecoder((frame) => this.handleFrame(frame), (err) => this.handleProtocolError(err));
        transport.onData((data) => {
            if (this.disposed) {
                return;
            }
            this.lastReceivedAt = Date.now();
            this.decoder.feed(data);
        });
        transport.onClose(() => {
            this.dispose('connection_lost');
        });
        this.startKeepalive();
        this.startTimeoutCheck();
    }
    onNotification(handler) {
        this.notificationHandlers.push(handler);
        return () => {
            const idx = this.notificationHandlers.indexOf(handler);
            if (idx !== -1) {
                this.notificationHandlers.splice(idx, 1);
            }
        };
    }
    /**
     * Send a JSON-RPC request and wait for the response.
     */
    async request(method, params) {
        if (this.disposed) {
            throw new Error('Multiplexer disposed');
        }
        const id = this.nextRequestId++;
        const msg = {
            jsonrpc: '2.0',
            id,
            method,
            ...(params !== undefined ? { params } : {})
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
            }, REQUEST_TIMEOUT_MS);
            this.pendingRequests.set(id, { resolve, reject, timer });
            this.sendMessage(msg);
        });
    }
    /**
     * Send a JSON-RPC notification (no response expected).
     */
    notify(method, params) {
        if (this.disposed) {
            return;
        }
        const msg = {
            jsonrpc: '2.0',
            method,
            ...(params !== undefined ? { params } : {})
        };
        this.sendMessage(msg);
    }
    dispose(reason = 'shutdown') {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        if (this.timeoutTimer) {
            clearInterval(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        // Why: the renderer uses the error code to distinguish temporary disconnects
        // (show reconnection overlay) from permanent shutdown (show error toast).
        const errorMessage = reason === 'connection_lost' ? 'SSH connection lost, reconnecting...' : 'Multiplexer disposed';
        const errorCode = reason === 'connection_lost' ? 'CONNECTION_LOST' : 'DISPOSED';
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            const err = new Error(errorMessage);
            err.code = errorCode;
            pending.reject(err);
            this.pendingRequests.delete(id);
        }
        this.decoder.reset();
    }
    isDisposed() {
        return this.disposed;
    }
    // ── Private ───────────────────────────────────────────────────────
    sendMessage(msg) {
        const seq = this.nextOutgoingSeq++;
        const frame = encodeJsonRpcFrame(msg, seq, this.highestReceivedSeq);
        this.unackedTimestamps.set(seq, Date.now());
        this.transport.write(frame);
    }
    sendKeepAlive() {
        if (this.disposed) {
            return;
        }
        const seq = this.nextOutgoingSeq++;
        const frame = encodeKeepAliveFrame(seq, this.highestReceivedSeq);
        this.unackedTimestamps.set(seq, Date.now());
        this.transport.write(frame);
    }
    handleFrame(frame) {
        // Update ack tracking
        if (frame.id > this.highestReceivedSeq) {
            this.highestReceivedSeq = frame.id;
        }
        // Process ack from remote: discard timestamps for acked messages
        if (frame.ack > this.highestAckedBySelf) {
            for (let i = this.highestAckedBySelf + 1; i <= frame.ack; i++) {
                this.unackedTimestamps.delete(i);
            }
            this.highestAckedBySelf = frame.ack;
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
                this.handleProtocolError(err);
            }
        }
    }
    handleMessage(msg) {
        if ('id' in msg && ('result' in msg || 'error' in msg)) {
            this.handleResponse(msg);
        }
        else if ('method' in msg && !('id' in msg)) {
            this.handleNotification(msg);
        }
        // Requests from relay to client are not expected in Phase 2
    }
    handleResponse(msg) {
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
            const err = new Error(msg.error.message);
            Object.defineProperty(err, 'code', { value: msg.error.code });
            Object.defineProperty(err, 'data', { value: msg.error.data });
            pending.reject(err);
        }
        else {
            pending.resolve(msg.result);
        }
    }
    handleNotification(msg) {
        const params = msg.params ?? {};
        // Why: handlers may unsubscribe during iteration (via the returned disposer
        // from onNotification), which splices the live array and skips the next handler.
        // Iterating a snapshot prevents that.
        const snapshot = Array.from(this.notificationHandlers);
        for (const handler of snapshot) {
            handler(msg.method, params);
        }
    }
    startKeepalive() {
        this.keepaliveTimer = setInterval(() => {
            this.sendKeepAlive();
        }, KEEPALIVE_SEND_MS);
    }
    startTimeoutCheck() {
        this.timeoutTimer = setInterval(() => {
            if (this.disposed) {
                return;
            }
            const now = Date.now();
            const noDataReceived = now - this.lastReceivedAt > TIMEOUT_MS;
            // Check oldest unacked message
            let oldestUnacked = Infinity;
            for (const ts of this.unackedTimestamps.values()) {
                if (ts < oldestUnacked) {
                    oldestUnacked = ts;
                }
            }
            const oldestUnackedStale = oldestUnacked !== Infinity && now - oldestUnacked > TIMEOUT_MS;
            // Connection considered dead when BOTH conditions met
            if (noDataReceived && oldestUnackedStale) {
                this.handleProtocolError(new Error('Connection timed out (no ack received)'));
            }
        }, KEEPALIVE_SEND_MS);
    }
    handleProtocolError(err) {
        console.warn(`[ssh-mux] Protocol error: ${err instanceof Error ? err.message : String(err)}`);
        this.dispose('connection_lost');
    }
}
