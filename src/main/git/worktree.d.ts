import type { GitWorktreeInfo } from '../../shared/types';
/**
 * Parse the porcelain output of `git worktree list --porcelain`.
 */
export declare function parseWorktreeList(output: string): GitWorktreeInfo[];
/**
 * List all worktrees for a git repo at the given path.
 */
export declare function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]>;
/**
 * Create a new worktree.
 * @param repoPath - Path to the main repo (or bare repo)
 * @param worktreePath - Absolute path where the worktree will be created
 * @param branch - Branch name for the new worktree
 * @param baseBranch - Optional base branch to create from (defaults to HEAD)
 */
export declare function addWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch?: string, refreshLocalBaseRef?: boolean): Promise<void>;
/**
 * Remove a worktree.
 */
export declare function removeWorktree(repoPath: string, worktreePath: string, force?: boolean): Promise<void>;
