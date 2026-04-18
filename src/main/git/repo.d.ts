/**
 * Check if a path is a valid git repository (regular or bare).
 */
export declare function isGitRepo(path: string): boolean;
/**
 * Get a human-readable name for the repo from its path.
 */
export declare function getRepoName(path: string): string;
/**
 * Get the remote origin URL, or null if not set.
 */
export declare function getRemoteUrl(path: string): string | null;
/**
 * Get the best username-style branch prefix for the repo.
 */
export declare function getGitUsername(path: string): string;
/**
 * Resolve the default base ref for new worktrees.
 * Prefer the remote primary branch over a potentially stale local branch.
 */
export declare function getDefaultBaseRef(path: string): string;
export declare function getBaseRefDefault(path: string): Promise<string>;
export declare function searchBaseRefs(path: string, query: string, limit?: number): Promise<string[]>;
export type BranchConflictKind = 'local' | 'remote';
export declare function getBranchConflictKind(path: string, branchName: string): Promise<BranchConflictKind | null>;
/**
 * Build a hosted URL (e.g. GitHub, GitLab, Bitbucket) for a specific file
 * and line in the repo. Returns null when the remote isn't a recognized host.
 *
 * Why hosted-git-info: it handles SSH, HTTPS, and shorthand remote URLs
 * across multiple providers, so we don't have to maintain our own URL parser.
 */
export declare function getRemoteFileUrl(repoPath: string, relativePath: string, line: number): string | null;
