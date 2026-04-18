export declare class RelayContext {
    readonly authorizedRoots: Set<string>;
    private rootsRegistered;
    registerRoot(rootPath: string): void;
    validatePath(targetPath: string): void;
    validatePathResolved(targetPath: string): Promise<void>;
}
