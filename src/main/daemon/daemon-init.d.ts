export declare function initDaemonPtyProvider(): Promise<void>;
export declare function disconnectDaemon(): void;
/** Kill the daemon and all its sessions. Use for full cleanup only. */
export declare function shutdownDaemon(): Promise<void>;
