export declare class OpenCodeHookService {
    private server;
    private port;
    private token;
    private lastStatusByPtyId;
    start(): Promise<void>;
    stop(): void;
    clearPty(ptyId: string): void;
    buildPtyEnv(ptyId: string): Record<string, string>;
    private writePluginConfig;
}
export declare const openCodeHookService: OpenCodeHookService;
