import type { Store } from '../persistence';
export declare const PATH_ACCESS_DENIED_MESSAGE = "Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.";
export declare function authorizeExternalPath(targetPath: string): void;
export declare function invalidateAuthorizedRootsCache(): void;
/**
 * Check whether resolvedTarget is equal to or a descendant of resolvedBase.
 * Uses relative() so it works with both `/` (Unix) and `\` (Windows) separators.
 */
export declare function isDescendantOrEqual(resolvedTarget: string, resolvedBase: string): boolean;
export declare function getAllowedRoots(store: Store): string[];
export declare function isPathAllowed(targetPath: string, store: Store): boolean;
export declare function rebuildAuthorizedRootsCache(store: Store): Promise<void>;
export declare function ensureAuthorizedRootsCache(store: Store): Promise<void>;
/**
 * Returns true if the error is an ENOENT (file-not-found) error.
 */
export declare function isENOENT(error: unknown): boolean;
export declare function resolveAuthorizedPath(targetPath: string, store: Store): Promise<string>;
/**
 * Resolve and verify that a worktree path belongs to a registered repo.
 *
 * Why this doesn't use resolveAuthorizedPath: linked worktrees can live
 * anywhere on disk (e.g. ~/.codex/worktrees/), far outside the repo root
 * and workspaceDir that resolveAuthorizedPath allows.  The security boundary
 * for git operations is *worktree registration* — the path must match a
 * worktree reported by `git worktree list` for a known repo — not
 * directory containment within allowed roots.
 */
export declare function resolveRegisteredWorktreePath(worktreePath: string, store: Store): Promise<string>;
export declare function validateGitRelativeFilePath(worktreePath: string, filePath: string): string;
