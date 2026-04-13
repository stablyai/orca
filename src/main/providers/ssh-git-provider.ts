import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { IGitProvider } from './types'
import type {
  GitStatusResult,
  GitDiffResult,
  GitBranchCompareResult,
  GitConflictOperation,
  GitWorktreeInfo
} from '../../shared/types'

export class SshGitProvider implements IGitProvider {
  private connectionId: string
  private mux: SshChannelMultiplexer

  constructor(connectionId: string, mux: SshChannelMultiplexer) {
    this.connectionId = connectionId
    this.mux = mux
  }

  getConnectionId(): string {
    return this.connectionId
  }

  async getStatus(worktreePath: string): Promise<GitStatusResult> {
    return (await this.mux.request('git.status', { worktreePath })) as GitStatusResult
  }

  async getDiff(worktreePath: string, filePath: string, staged: boolean): Promise<GitDiffResult> {
    return (await this.mux.request('git.diff', {
      worktreePath,
      filePath,
      staged
    })) as GitDiffResult
  }

  async stageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.mux.request('git.stage', { worktreePath, filePath })
  }

  async unstageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.mux.request('git.unstage', { worktreePath, filePath })
  }

  async bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.mux.request('git.bulkStage', { worktreePath, filePaths })
  }

  async bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.mux.request('git.bulkUnstage', { worktreePath, filePaths })
  }

  async discardChanges(worktreePath: string, filePath: string): Promise<void> {
    await this.mux.request('git.discard', { worktreePath, filePath })
  }

  async detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
    return (await this.mux.request('git.conflictOperation', {
      worktreePath
    })) as GitConflictOperation
  }

  async getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult> {
    return (await this.mux.request('git.branchCompare', {
      worktreePath,
      baseRef
    })) as GitBranchCompareResult
  }

  async getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string }
  ): Promise<GitDiffResult[]> {
    return (await this.mux.request('git.branchDiff', {
      worktreePath,
      baseRef,
      ...options
    })) as GitDiffResult[]
  }

  async listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
    return (await this.mux.request('git.listWorktrees', {
      repoPath
    })) as GitWorktreeInfo[]
  }

  async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; track?: boolean }
  ): Promise<void> {
    await this.mux.request('git.addWorktree', {
      repoPath,
      branchName,
      targetDir,
      ...options
    })
  }

  async removeWorktree(worktreePath: string, force?: boolean): Promise<void> {
    await this.mux.request('git.removeWorktree', { worktreePath, force })
  }

  async exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return (await this.mux.request('git.exec', { args, cwd })) as {
      stdout: string
      stderr: string
    }
  }

  async isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }> {
    return (await this.mux.request('git.isGitRepo', { dirPath })) as {
      isRepo: boolean
      rootPath: string | null
    }
  }

  // Why: isGitRepo requires synchronous return in the interface, but remote
  // operations are async. We always return true for remote paths since the
  // relay validates git repos on its side. The renderer already guards git
  // operations behind worktree registration which validates the path.
  isGitRepo(_path: string): boolean {
    return true
  }
}
