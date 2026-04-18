export declare class PiTitlebarExtensionService {
    private getOverlayDir;
    private mirrorAgentDir;
    buildPtyEnv(ptyId: string, existingAgentDir: string | undefined): Record<string, string>;
    clearPty(ptyId: string): void;
}
export declare const piTitlebarExtensionService: PiTitlebarExtensionService;
