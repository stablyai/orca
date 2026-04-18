// Self-contained relay protocol — mirrors src/main/ssh/relay-protocol.ts
// but has no Electron dependencies. Deployed standalone to remote hosts.
export const RELAY_VERSION = '0.1.0';
export const RELAY_SENTINEL = `ORCA-RELAY v${RELAY_VERSION} READY\n`;
export const HEADER_LENGTH = 13;
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;
export const MessageType = {
    Regular: 1,
    KeepAlive: 9
};
export const KEEPALIVE_SEND_MS = 5_000;
export const TIMEOUT_MS = 20_000;
export function encodeFrame(type, id, ack, payload) {
    const header = Buffer.alloc(HEADER_LENGTH);
    header[0] = type;
    header.writeUInt32BE(id, 1);
    header.writeUInt32BE(ack, 5);
    header.writeUInt32BE(payload.length, 9);
    return Buffer.concat([header, payload]);
}
export function encodeJsonRpcFrame(msg, id, ack) {
    const payload = Buffer.from(JSON.stringify(msg), 'utf-8');
    if (payload.length > MAX_MESSAGE_SIZE) {
        throw new Error(`Message too large: ${payload.length} bytes`);
    }
    return encodeFrame(MessageType.Regular, id, ack, payload);
}
export function encodeKeepAliveFrame(id, ack) {
    return encodeFrame(MessageType.KeepAlive, id, ack, Buffer.alloc(0));
}
export class FrameDecoder {
    buffer = Buffer.alloc(0);
    onFrame;
    onError;
    constructor(onFrame, onError) {
        this.onFrame = onFrame;
        this.onError = onError ?? null;
    }
    feed(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= HEADER_LENGTH) {
            const length = this.buffer.readUInt32BE(9);
            const totalLength = HEADER_LENGTH + length;
            if (length > MAX_MESSAGE_SIZE) {
                // Why: Throwing here would leave the buffer in a partially consumed
                // state — subsequent feed() calls would try to parse the leftover
                // payload bytes as a new header, corrupting every future frame.
                // Instead we skip the entire oversized frame so the decoder stays
                // synchronized with the stream.
                if (this.buffer.length < totalLength) {
                    // Haven't received the full oversized payload yet; wait for more data.
                    break;
                }
                this.buffer = this.buffer.subarray(totalLength);
                const err = new Error(`Frame payload too large: ${length} bytes — discarded`);
                if (this.onError) {
                    this.onError(err);
                }
                else {
                    process.stderr.write(`[relay] ${err.message}\n`);
                }
                continue;
            }
            if (this.buffer.length < totalLength) {
                break;
            }
            const frame = {
                type: this.buffer[0],
                id: this.buffer.readUInt32BE(1),
                ack: this.buffer.readUInt32BE(5),
                payload: this.buffer.subarray(HEADER_LENGTH, totalLength)
            };
            this.buffer = this.buffer.subarray(totalLength);
            this.onFrame(frame);
        }
    }
    reset() {
        this.buffer = Buffer.alloc(0);
    }
}
export function parseJsonRpcMessage(payload) {
    const text = payload.toString('utf-8');
    const msg = JSON.parse(text);
    if (msg.jsonrpc !== '2.0') {
        throw new Error(`Invalid JSON-RPC version: ${msg.jsonrpc}`);
    }
    return msg;
}
