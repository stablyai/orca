export declare const RELAY_VERSION = "0.1.0";
export declare const RELAY_SENTINEL = "ORCA-RELAY v0.1.0 READY\n";
export declare const HEADER_LENGTH = 13;
export declare const MAX_MESSAGE_SIZE: number;
export declare const MessageType: {
    readonly Regular: 1;
    readonly KeepAlive: 9;
};
export declare const KEEPALIVE_SEND_MS = 5000;
export declare const TIMEOUT_MS = 20000;
export type JsonRpcRequest = {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: Record<string, unknown>;
};
export type JsonRpcResponse = {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
};
export type JsonRpcNotification = {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
};
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
export type DecodedFrame = {
    type: number;
    id: number;
    ack: number;
    payload: Buffer;
};
export declare function encodeFrame(type: number, id: number, ack: number, payload: Buffer | Uint8Array): Buffer;
export declare function encodeJsonRpcFrame(msg: JsonRpcMessage, id: number, ack: number): Buffer;
export declare function encodeKeepAliveFrame(id: number, ack: number): Buffer;
export declare class FrameDecoder {
    private buffer;
    private onFrame;
    private onError;
    constructor(onFrame: (frame: DecodedFrame) => void, onError?: (err: Error) => void);
    feed(chunk: Buffer | Uint8Array): void;
    reset(): void;
}
export declare function parseJsonRpcMessage(payload: Buffer): JsonRpcMessage;
