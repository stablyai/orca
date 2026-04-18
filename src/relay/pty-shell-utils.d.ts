/**
 * Resolve the default shell for PTY spawning.
 * Prefers $SHELL, then common fallbacks.
 */
export declare function resolveDefaultShell(): string;
/**
 * Resolve the current working directory of a process by pid.
 * Tries /proc on Linux and lsof on macOS before falling back to `fallbackCwd`.
 */
export declare function resolveProcessCwd(pid: number, fallbackCwd: string): Promise<string>;
/**
 * Check whether a process has child processes (via pgrep).
 */
export declare function processHasChildren(pid: number): Promise<boolean>;
/**
 * Get the foreground process name of a given pid (via ps).
 */
export declare function getForegroundProcessName(pid: number): Promise<string | null>;
/**
 * List available shell profiles from /etc/shells (or known fallbacks).
 */
export declare function listShellProfiles(): {
    name: string;
    path: string;
}[];
