import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer';
import type { IGitProvider } from './types';
import type { GitStatusResult, GitDiffResult, GitBranchCompareResult, GitConflictOperation, GitWorktreeInfo } from '../../shared/types';
export declare class SshGitProvider implements IGitProvider {
    private connectionId;
    private mux;
    constructor(connectionId: string, mux: SshChannelMultiplexer);
    getConnectionId(): string;
    getStatus(worktreePath: string): Promise<GitStatusResult>;
    getDiff(worktreePath: string, filePath: string, staged: boolean): Promise<GitDiffResult>;
    stageFile(worktreePath: string, filePath: string): Promise<void>;
    unstageFile(worktreePath: string, filePath: string): Promise<void>;
    bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void>;
    bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void>;
    discardChanges(worktreePath: string, filePath: string): Promise<void>;
    detectConflictOperation(worktreePath: string): Promise<GitConflictOperation>;
    getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult>;
    getBranchDiff(worktreePath: string, baseRef: string, options?: {
        includePatch?: boolean;
        filePath?: string;
        oldPath?: string;
    }): Promise<GitDiffResult[]>;
    listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]>;
    addWorktree(repoPath: string, branchName: string, targetDir: string, options?: {
        base?: string;
        track?: boolean;
    }): Promise<void>;
    removeWorktree(worktreePath: string, force?: boolean): Promise<void>;
    exec(args: string[], cwd: string): Promise<{
        stdout: string;
        stderr: string;
    }>;
    isGitRepoAsync(dirPath: string): Promise<{
        isRepo: boolean;
        rootPath: string | null;
    }>;
    isGitRepo(_path: string): boolean;
    getRemoteFileUrl(worktreePath: string, relativePath: string, line: number): Promise<string | null>;
}
