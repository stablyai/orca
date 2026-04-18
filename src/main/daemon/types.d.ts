export declare const PROTOCOL_VERSION = 1;
export type SessionState = 'created' | 'spawning' | 'running' | 'exiting' | 'exited';
export type ShellReadyState = 'pending' | 'ready' | 'timed_out' | 'unsupported';
export type TerminalSnapshot = {
    snapshotAnsi: string;
    /** Scrollback portion only (rows above the visible viewport). Write this
     *  to preserve history without interfering with TUI repaints. */
    scrollbackAnsi: string;
    rehydrateSequences: string;
    cwd: string | null;
    modes: TerminalModes;
    cols: number;
    rows: number;
    scrollbackLines: number;
};
export type TerminalModes = {
    bracketedPaste: boolean;
    mouseTracking: boolean;
    applicationCursor: boolean;
    alternateScreen: boolean;
};
export type HelloMessage = {
    type: 'hello';
    version: number;
    token: string;
    clientId: string;
    role: 'control' | 'stream';
};
export type HelloResponse = {
    type: 'hello';
    ok: boolean;
    error?: string;
};
export type CreateOrAttachRequest = {
    id: string;
    type: 'createOrAttach';
    payload: {
        sessionId: string;
        cols: number;
        rows: number;
        cwd?: string;
        env?: Record<string, string>;
        command?: string;
        shellReadySupported?: boolean;
    };
};
export type CancelCreateOrAttachRequest = {
    id: string;
    type: 'cancelCreateOrAttach';
    payload: {
        sessionId: string;
    };
};
export type WriteRequest = {
    id: string;
    type: 'write';
    payload: {
        sessionId: string;
        data: string;
    };
};
export type ResizeRequest = {
    id: string;
    type: 'resize';
    payload: {
        sessionId: string;
        cols: number;
        rows: number;
    };
};
export type KillRequest = {
    id: string;
    type: 'kill';
    payload: {
        sessionId: string;
    };
};
export type SignalRequest = {
    id: string;
    type: 'signal';
    payload: {
        sessionId: string;
        signal: string;
    };
};
export type ListSessionsRequest = {
    id: string;
    type: 'listSessions';
};
export type DetachRequest = {
    id: string;
    type: 'detach';
    payload: {
        sessionId: string;
    };
};
export type GetCwdRequest = {
    id: string;
    type: 'getCwd';
    payload: {
        sessionId: string;
    };
};
export type ClearScrollbackRequest = {
    id: string;
    type: 'clearScrollback';
    payload: {
        sessionId: string;
    };
};
export type ShutdownRequest = {
    id: string;
    type: 'shutdown';
    payload: {
        killSessions: boolean;
    };
};
export type DaemonRequest = CreateOrAttachRequest | CancelCreateOrAttachRequest | WriteRequest | ResizeRequest | KillRequest | SignalRequest | ListSessionsRequest | DetachRequest | GetCwdRequest | ClearScrollbackRequest | ShutdownRequest;
export type RpcResponseOk<T = unknown> = {
    id: string;
    ok: true;
    payload: T;
};
export type RpcResponseError = {
    id: string;
    ok: false;
    error: string;
};
export type RpcResponse<T = unknown> = RpcResponseOk<T> | RpcResponseError;
export type CreateOrAttachResult = {
    isNew: boolean;
    snapshot: TerminalSnapshot | null;
    pid: number | null;
    shellState: ShellReadyState;
};
export type ListSessionsResult = {
    sessions: SessionInfo[];
};
export type SessionInfo = {
    sessionId: string;
    state: SessionState;
    shellState: ShellReadyState;
    isAlive: boolean;
    pid: number | null;
    cwd: string | null;
    cols: number;
    rows: number;
    createdAt: number;
};
export type DataEvent = {
    type: 'event';
    event: 'data';
    sessionId: string;
    payload: {
        data: string;
    };
};
export type ExitEvent = {
    type: 'event';
    event: 'exit';
    sessionId: string;
    payload: {
        code: number;
    };
};
export type TerminalErrorEvent = {
    type: 'event';
    event: 'terminalError';
    sessionId: string;
    payload: {
        message: string;
    };
};
export type DaemonEvent = DataEvent | ExitEvent | TerminalErrorEvent;
export declare const enum FrameType {
    Data = 1,
    Resize = 2,
    Exit = 3,
    Error = 4,
    Kill = 5,
    Signal = 6
}
export declare const FRAME_HEADER_SIZE = 5;
export declare const FRAME_MAX_PAYLOAD: number;
export declare const NOTIFY_PREFIX = "notify_";
export declare class TerminalAttachCanceledError extends Error {
    constructor(sessionId: string);
}
export declare class DaemonProtocolError extends Error {
    constructor(message: string);
}
export declare class SessionNotFoundError extends Error {
    constructor(sessionId: string);
}
