import type {
  GitBranchCompareResult,
  GitCommitCompareResult
} from '../../shared/git-diff-compare-types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { GitConflictOperation } from '../../shared/git-status-types'
import { SshGitNoninteractiveProvider } from './ssh-git-noninteractive-provider'

export class SshGitWorkingTreeProvider extends SshGitNoninteractiveProvider {
  async checkIgnoredPaths(worktreePath: string, relativePaths: string[]): Promise<string[]> {
    return (await this.mux.request('git.checkIgnored', {
      worktreePath,
      paths: relativePaths
    })) as string[]
  }

  async getHistory(
    worktreePath: string,
    options: GitHistoryOptions = {}
  ): Promise<GitHistoryResult> {
    return (await this.mux.request('git.history', {
      worktreePath,
      ...options
    })) as GitHistoryResult
  }

  async commit(
    worktreePath: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.runWithGitReadInvalidation(
      async () =>
        (await this.mux.request('git.commit', {
          worktreePath,
          message
        })) as { success: boolean; error?: string }
    )
  }

  async stageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.stage', { worktreePath, filePath })
    })
  }

  async unstageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.unstage', { worktreePath, filePath })
    })
  }

  async bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.bulkStage', { worktreePath, filePaths })
    })
  }

  async bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.bulkUnstage', { worktreePath, filePaths })
    })
  }

  async discardChanges(worktreePath: string, filePath: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.discard', { worktreePath, filePath })
    })
  }

  async bulkDiscardChanges(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.bulkDiscard', { worktreePath, filePaths })
    })
  }

  async detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
    return (await this.mux.request('git.conflictOperation', {
      worktreePath
    })) as GitConflictOperation
  }

  async abortMerge(worktreePath: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.abortMerge', { worktreePath })
    })
  }

  async abortRebase(worktreePath: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.abortRebase', { worktreePath })
    })
  }

  async checkoutBranch(worktreePath: string, branch: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.checkout', { worktreePath, branch })
    })
  }

  async listLocalBranches(
    worktreePath: string
  ): Promise<{ current: string | null; branches: string[] }> {
    return (await this.mux.request('git.localBranches', { worktreePath })) as {
      current: string | null
      branches: string[]
    }
  }

  async getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult> {
    return (await this.mux.request('git.branchCompare', {
      worktreePath,
      baseRef
    })) as GitBranchCompareResult
  }

  async getCommitCompare(worktreePath: string, commitId: string): Promise<GitCommitCompareResult> {
    return (await this.mux.request('git.commitCompare', {
      worktreePath,
      commitId
    })) as GitCommitCompareResult
  }
}
