export type DaemonConnectionInfo = {
    socketPath: string;
    tokenPath: string;
};
export type DaemonProcessHandle = {
    shutdown(): Promise<void>;
};
export type DaemonLauncher = (socketPath: string, tokenPath: string) => Promise<DaemonProcessHandle>;
export type DaemonSpawnerOptions = {
    runtimeDir: string;
    launcher: DaemonLauncher;
};
export declare class DaemonSpawner {
    private runtimeDir;
    private launcher;
    private handle;
    private socketPath;
    private tokenPath;
    constructor(opts: DaemonSpawnerOptions);
    ensureRunning(): Promise<DaemonConnectionInfo>;
    shutdown(): Promise<void>;
}
export declare function getDaemonSocketPath(runtimeDir: string): string;
export declare function getDaemonTokenPath(runtimeDir: string): string;
