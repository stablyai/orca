type ShellKind = 'zsh' | 'bash' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'unknown';
/** Resolve the shell kind from a shell binary path.
 *  Uses basename + prefix matching to handle versioned names like `bash-5.2`
 *  and nix-store paths like `/nix/store/.../bin/zsh`. */
export declare function resolveShellKind(shellPath: string): ShellKind;
/** First 16 hex chars of SHA-256 of the worktreeId. */
export declare function hashWorktreeId(worktreeId: string): string;
/** Ensure the history directory exists for a given worktree hash.
 *  Returns the directory path, or null if creation failed. */
export declare function ensureHistoryDir(worktreeHash: string, wslDistro?: string): string | null;
export type HistoryInjectionResult = {
    shell: ShellKind;
    histFile: string | null;
};
/** Build shell-specific history env overrides for a PTY spawn.
 *  Returns the injection result for diagnostics logging.
 *
 *  Why this is the industry-standard approach: Ghostty, Kitty, and VS Code
 *  all use check-before-set for HISTFILE. The major zsh frameworks (oh-my-zsh,
 *  Prezto) guard their HISTFILE assignments, so env-var injection works for
 *  the vast majority of users (see design doc §9). */
export declare function injectHistoryEnv(spawnEnv: Record<string, string>, worktreeId: string, shellPath: string, cwd: string): HistoryInjectionResult;
/** Update HISTFILE in spawnEnv when shell fallback changes the shell kind.
 *  For example, if zsh fails and bash takes over, the HISTFILE should point
 *  to bash_history instead of zsh_history. */
export declare function updateHistFileForFallback(spawnEnv: Record<string, string>, fallbackShellPath: string): void;
/** Log the history injection result for diagnostics. */
export declare function logHistoryInjection(worktreeId: string, result: HistoryInjectionResult): void;
/** Delete the history directory for a removed worktree. Non-fatal. */
export declare function deleteWorktreeHistoryDir(worktreeId: string): void;
/** Run background GC to prune history directories for worktrees that no
 *  longer exist. Must be called after live worktree enumeration is complete
 *  to avoid deleting history for worktrees that haven't been discovered yet. */
export declare function runHistoryGc(liveWorktreeIds: Set<string>): void;
/** Schedule GC after a delay so it runs after workspace hydration completes.
 *  `getLiveWorktreeIds` should enumerate all currently known worktree IDs
 *  (e.g. by listing repos and their git worktrees). */
export declare function scheduleHistoryGc(getLiveWorktreeIds: () => Promise<Set<string>>): void;
export {};
