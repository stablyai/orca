export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;
export type NotificationHandler = (params: Record<string, unknown>) => void;
export declare class RelayDispatcher {
    private decoder;
    private write;
    private requestHandlers;
    private notificationHandlers;
    private nextOutgoingSeq;
    private highestReceivedSeq;
    private keepaliveTimer;
    private disposed;
    constructor(write: (data: Buffer) => void);
    onRequest(method: string, handler: MethodHandler): void;
    onNotification(method: string, handler: NotificationHandler): void;
    feed(data: Buffer): void;
    notify(method: string, params?: Record<string, unknown>): void;
    dispose(): void;
    private handleFrame;
    private handleMessage;
    private handleRequest;
    private handleNotification;
    private sendResponse;
    private sendFrame;
    private startKeepalive;
}
