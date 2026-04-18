// ─── Protocol Version ────────────────────────────────────────────────
export const PROTOCOL_VERSION = 1;
// ─── Binary Frame Protocol (Daemon ↔ PTY Subprocess) ────────────────
//
// 5-byte header: [type:1][length:4 big-endian]
// Followed by `length` bytes of payload.
export var FrameType;
(function (FrameType) {
    FrameType[FrameType["Data"] = 1] = "Data";
    FrameType[FrameType["Resize"] = 2] = "Resize";
    FrameType[FrameType["Exit"] = 3] = "Exit";
    FrameType[FrameType["Error"] = 4] = "Error";
    FrameType[FrameType["Kill"] = 5] = "Kill";
    FrameType[FrameType["Signal"] = 6] = "Signal";
})(FrameType || (FrameType = {}));
export const FRAME_HEADER_SIZE = 5;
export const FRAME_MAX_PAYLOAD = 1024 * 1024; // 1MB
// ─── Notify prefix ──────────────────────────────────────────────────
// Requests with IDs starting with this prefix are fire-and-forget:
// the daemon processes them but does not send a response.
export const NOTIFY_PREFIX = 'notify_';
// ─── Error types ────────────────────────────────────────────────────
export class TerminalAttachCanceledError extends Error {
    constructor(sessionId) {
        super(`Attach canceled for session ${sessionId}`);
        this.name = 'TerminalAttachCanceledError';
    }
}
export class DaemonProtocolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DaemonProtocolError';
    }
}
export class SessionNotFoundError extends Error {
    constructor(sessionId) {
        super(`Session not found: ${sessionId}`);
        this.name = 'SessionNotFoundError';
    }
}
