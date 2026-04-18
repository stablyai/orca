import * as path from 'path';
import type { GitBranchCompareResult, GitConflictOperation, GitDiffResult, GitStatusResult } from '../../shared/types';
/**
 * Parse `git status --porcelain=v2` output into structured entries.
 */
export declare function getStatus(worktreePath: string): Promise<GitStatusResult>;
export declare function detectConflictOperation(worktreePath: string): Promise<GitConflictOperation>;
/**
 * Get original and modified content for diffing a file.
 */
export declare function getDiff(worktreePath: string, filePath: string, staged: boolean): Promise<GitDiffResult>;
export declare function getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult>;
export declare function getBranchDiff(worktreePath: string, args: {
    headOid: string;
    mergeBase: string;
    filePath: string;
    oldPath?: string;
}): Promise<GitDiffResult>;
/**
 * Stage a file.
 */
export declare function stageFile(worktreePath: string, filePath: string): Promise<void>;
/**
 * Unstage a file.
 */
export declare function unstageFile(worktreePath: string, filePath: string): Promise<void>;
/**
 * Discard working tree changes for a file.
 */
export declare function discardChanges(worktreePath: string, filePath: string): Promise<void>;
export declare function isWithinWorktree(pathApi: Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'>, resolvedWorktree: string, resolvedTarget: string): boolean;
/**
 * Bulk stage files in batches to avoid E2BIG.
 */
export declare function bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void>;
/**
 * Bulk unstage files in batches to avoid E2BIG.
 */
export declare function bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void>;
