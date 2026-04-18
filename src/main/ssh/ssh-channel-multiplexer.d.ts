export type MultiplexerTransport = {
    write: (data: Buffer) => void;
    onData: (cb: (data: Buffer) => void) => void;
    onClose: (cb: () => void) => void;
};
export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;
export declare class SshChannelMultiplexer {
    private decoder;
    private transport;
    private nextRequestId;
    private nextOutgoingSeq;
    private highestReceivedSeq;
    private highestAckedBySelf;
    private lastReceivedAt;
    private pendingRequests;
    private notificationHandlers;
    private keepaliveTimer;
    private timeoutTimer;
    private disposed;
    private unackedTimestamps;
    constructor(transport: MultiplexerTransport);
    onNotification(handler: NotificationHandler): () => void;
    /**
     * Send a JSON-RPC request and wait for the response.
     */
    request(method: string, params?: Record<string, unknown>): Promise<unknown>;
    /**
     * Send a JSON-RPC notification (no response expected).
     */
    notify(method: string, params?: Record<string, unknown>): void;
    dispose(reason?: 'shutdown' | 'connection_lost'): void;
    isDisposed(): boolean;
    private sendMessage;
    private sendKeepAlive;
    private handleFrame;
    private handleMessage;
    private handleResponse;
    private handleNotification;
    private startKeepalive;
    private startTimeoutCheck;
    private handleProtocolError;
}
