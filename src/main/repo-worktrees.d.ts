import type { GitWorktreeInfo, Repo } from '../shared/types';
export declare function createFolderWorktree(repo: Repo): GitWorktreeInfo;
export declare function listRepoWorktrees(repo: Repo): Promise<GitWorktreeInfo[]>;
