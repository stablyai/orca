import type { GitWorktreeInfo, Worktree, WorktreeMeta } from '../../shared/types';
/**
 * Sanitize a worktree name for use in branch names and directory paths.
 * Strips unsafe characters and collapses runs of special chars to a single hyphen.
 */
export declare function sanitizeWorktreeName(input: string): string;
/**
 * Ensure a target path is within the workspace directory (prevent path traversal).
 */
export declare function ensurePathWithinWorkspace(targetPath: string, workspaceDir: string): string;
/**
 * Compute the full branch name by applying the configured prefix strategy.
 */
export declare function computeBranchName(sanitizedName: string, settings: {
    branchPrefix: string;
    branchPrefixCustom?: string;
}, gitUsername: string | null): string;
/**
 * Compute the filesystem path where the worktree directory will be created.
 *
 * Why WSL special case: when the repo lives on a WSL filesystem, worktrees
 * must also live on the WSL filesystem. Creating them on the Windows side
 * (/mnt/c/...) would be extremely slow due to cross-filesystem I/O and
 * the terminal would open a Windows shell instead of WSL. We mirror the
 * Windows workspace layout inside ~/orca/workspaces on the WSL filesystem
 * (e.g. \\wsl.localhost\Ubuntu\home\user\orca\workspaces\repo\feature).
 */
export declare function computeWorktreePath(sanitizedName: string, repoPath: string, settings: {
    nestWorkspaces: boolean;
    workspaceDir: string;
}): string;
export declare function areWorktreePathsEqual(leftPath: string, rightPath: string, platform?: NodeJS.Platform): boolean;
/**
 * Determine whether a display name should be persisted.
 * A display name is set only when the user's requested name differs from
 * both the branch name and the sanitized name (i.e. it was modified).
 */
export declare function shouldSetDisplayName(requestedName: string, branchName: string, sanitizedName: string): boolean;
/**
 * Merge raw git worktree info with persisted user metadata into a full Worktree.
 */
export declare function mergeWorktree(repoId: string, git: GitWorktreeInfo, meta: WorktreeMeta | undefined, defaultDisplayName?: string): Worktree;
/**
 * Parse a composite worktreeId ("repoId::worktreePath") into its parts.
 */
export declare function parseWorktreeId(worktreeId: string): {
    repoId: string;
    worktreePath: string;
};
/**
 * Check whether a git error indicates the worktree is no longer tracked by git.
 * This happens when a worktree's internal git tracking is removed (e.g. via
 * `git worktree prune`) but the directory still exists on disk.
 */
export declare function isOrphanedWorktreeError(error: unknown): boolean;
/**
 * Format a human-readable error message for worktree removal failures.
 */
export declare function formatWorktreeRemovalError(error: unknown, worktreePath: string, force: boolean): string;
