export type DaemonClientOptions = {
    socketPath: string;
    tokenPath: string;
};
export declare class DaemonClient {
    private socketPath;
    private tokenPath;
    private clientId;
    private controlSocket;
    private streamSocket;
    private connected;
    private disconnectArmed;
    private connectingPromise;
    private pendingRequests;
    private eventListeners;
    private disconnectedListeners;
    private requestCounter;
    constructor(opts: DaemonClientOptions);
    isConnected(): boolean;
    ensureConnected(): Promise<void>;
    private doConnect;
    request<T = unknown>(type: string, payload: unknown): Promise<T>;
    notify(type: string, payload: unknown): void;
    onEvent(listener: (event: unknown) => void): () => void;
    onDisconnected(listener: () => void): () => void;
    disconnect(): void;
    private connectSocket;
    private sendHello;
    private setupControlParser;
    private setupStreamParser;
    private handleDisconnect;
}
