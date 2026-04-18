import type { SubprocessHandle } from './session';
export type DaemonServerOptions = {
    socketPath: string;
    tokenPath: string;
    spawnSubprocess: (opts: {
        sessionId: string;
        cols: number;
        rows: number;
        cwd?: string;
        env?: Record<string, string>;
        command?: string;
    }) => SubprocessHandle;
};
export declare class DaemonServer {
    private server;
    private token;
    private host;
    private socketPath;
    private tokenPath;
    private clients;
    constructor(opts: DaemonServerOptions);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    private handleConnection;
    private handleFirstMessage;
    private setupControlSocket;
    private handleRequest;
    private routeRequest;
}
