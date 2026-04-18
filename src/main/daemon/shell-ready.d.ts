export declare function resolvePtyShellPath(env: Record<string, string>): string;
export declare function supportsPtyStartupBarrier(env: Record<string, string>): boolean;
export declare function getShellReadyLaunchConfig(shellPath: string): {
    args: string[] | null;
    env: Record<string, string>;
    supportsReadyMarker: boolean;
};
