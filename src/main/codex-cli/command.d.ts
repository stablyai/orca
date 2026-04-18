type ResolveCommandOptions = {
    pathEnv?: string | null;
    platform?: NodeJS.Platform;
    homePath?: string;
};
export declare function resolveCodexCommand(options?: ResolveCommandOptions): string;
export declare function resolveClaudeCommand(options?: ResolveCommandOptions): string;
export declare function getVersionManagerBinPaths(options?: ResolveCommandOptions): string[];
export {};
