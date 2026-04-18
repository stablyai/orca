export declare const RELAY_VERSION = "0.1.0";
export declare const RELAY_SENTINEL = "ORCA-RELAY v0.1.0 READY\n";
export declare const RELAY_SENTINEL_TIMEOUT_MS = 10000;
export declare const RELAY_REMOTE_DIR = ".orca-remote";
export declare const HEADER_LENGTH = 13;
export declare const MAX_MESSAGE_SIZE: number;
/** Message type byte. */
export declare const MessageType: {
    readonly Regular: 1;
    readonly KeepAlive: 9;
};
/** Keepalive/timeout (VS Code ProtocolConstants). */
export declare const KEEPALIVE_SEND_MS = 5000;
export declare const TIMEOUT_MS = 20000;
/** PTY flow control watermarks (VS Code FlowControlConstants). */
export declare const PTY_FLOW_HIGH_WATERMARK = 100000;
export declare const PTY_FLOW_LOW_WATERMARK = 5000;
/** Reconnection grace period (default, overridable by relay --grace-time). */
export declare const DEFAULT_GRACE_TIME_MS: number;
export declare const RelayErrorCode: {
    readonly CommandNotFound: -33001;
    readonly PermissionDenied: -33002;
    readonly PathNotFound: -33003;
    readonly PtyAllocationFailed: -33004;
    readonly DiskFull: -33005;
};
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
/**
 * Encode a message into a framed buffer (13-byte header + payload).
 *
 * Header layout:
 * - [0]:    TYPE   (1 byte)
 * - [1-4]:  ID     (uint32 big-endian)
 * - [5-8]:  ACK    (uint32 big-endian)
 * - [9-12]: LENGTH (uint32 big-endian)
 */
export declare function encodeFrame(type: number, id: number, ack: number, payload: Buffer | Uint8Array): Buffer;
export declare function encodeJsonRpcFrame(msg: JsonRpcMessage, id: number, ack: number): Buffer;
export declare function encodeKeepAliveFrame(id: number, ack: number): Buffer;
export type DecodedFrame = {
    type: number;
    id: number;
    ack: number;
    payload: Buffer;
};
/**
 * Incremental frame parser. Feed it chunks of data; it emits complete frames.
 */
export declare class FrameDecoder {
    private buffer;
    private onFrame;
    private onError;
    constructor(onFrame: (frame: DecodedFrame) => void, onError?: (err: Error) => void);
    feed(chunk: Buffer | Uint8Array): void;
    reset(): void;
}
/**
 * Parse a JSON-RPC message from a frame payload.
 */
export declare function parseJsonRpcMessage(payload: Buffer): JsonRpcMessage;
export type RelayPlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64';
export declare function parseUnameToRelayPlatform(os: string, arch: string): RelayPlatform | null;
