import { type DaemonServerOptions } from './daemon-server';
export type DaemonStartOptions = {
    socketPath: string;
    tokenPath: string;
    spawnSubprocess: DaemonServerOptions['spawnSubprocess'];
};
export type DaemonHandle = {
    shutdown(): Promise<void>;
};
export declare function startDaemon(opts: DaemonStartOptions): Promise<DaemonHandle>;
