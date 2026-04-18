export type DaemonPtyProviderOptions = {
    socketPath: string;
    tokenPath: string;
};
export type DaemonSpawnOptions = {
    cols: number;
    rows: number;
    sessionId: string;
    cwd?: string;
    env?: Record<string, string>;
    command?: string;
};
export type DaemonSpawnResult = {
    id: string;
    isNew: boolean;
    pid: number | null;
};
export declare class DaemonPtyProvider {
    private client;
    private dataListeners;
    private exitListeners;
    private removeEventListener;
    constructor(opts: DaemonPtyProviderOptions);
    spawn(opts: DaemonSpawnOptions): Promise<DaemonSpawnResult>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    shutdown(id: string, _immediate: boolean): Promise<void>;
    onData(callback: (payload: {
        id: string;
        data: string;
    }) => void): () => void;
    onExit(callback: (payload: {
        id: string;
        code: number;
    }) => void): () => void;
    cleanup(): Promise<void>;
    private setupEventRouting;
}
