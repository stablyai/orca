import type * as pty from 'node-pty';
/**
 * Validate that a shell binary exists and is executable.
 * Returns an error message string if invalid, null if valid.
 */
export declare function getShellValidationError(shellPath: string): string | null;
/**
 * Ensure the node-pty spawn-helper binary has the executable bit set.
 *
 * Why: when Electron packages the app via asar, the native spawn-helper
 * binary may lose its +x permission. This function detects and repairs
 * that so pty.spawn() does not fail with EACCES on first launch.
 */
export declare function ensureNodePtySpawnHelperExecutable(): void;
/**
 * Validate that a working directory exists and is a directory.
 * Throws a descriptive Error if not.
 */
export declare function validateWorkingDirectory(cwd: string): void;
export type ShellSpawnParams = {
    shellPath: string;
    shellArgs: string[];
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    ptySpawn: typeof pty.spawn;
    getShellReadyConfig?: (shell: string) => {
        args: string[] | null;
        env: Record<string, string>;
    } | null;
    /** Called before each fallback shell spawn so callers can update env vars
     *  (e.g. HISTFILE) that depend on which shell is about to run. */
    onBeforeFallbackSpawn?: (env: Record<string, string>, fallbackShell: string) => void;
};
export type ShellSpawnResult = {
    process: pty.IPty;
    shellPath: string;
};
/**
 * Attempt to spawn a PTY shell. If the primary shell fails on Unix,
 * try common fallback shells before giving up.
 */
export declare function spawnShellWithFallback(params: ShellSpawnParams): ShellSpawnResult;
