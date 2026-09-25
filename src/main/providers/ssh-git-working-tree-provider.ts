import type {
  GitBranchCompareResult,
  GitCommitCompareResult
} from '../../shared/git-diff-compare-types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import type { GitConflictOperation } from '../../shared/git-status-types'
import {
  normalizeWorkingTreeCarryResult,
  type WorkingTreeCarryResult
} from '../../shared/working-tree-change-carry'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import { isSshRequestOutcomeUnverifiable } from '../ssh/ssh-channel-multiplexer'
import { SshGitNoninteractiveProvider } from './ssh-git-noninteractive-provider'

// Why: a carry can write up to 2,000 files / 200MB, well past the mux's default ~30s timeout.
const CARRY_WORKING_TREE_REQUEST_TIMEOUT_MS = 120_000

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

  async carryWorkingTreeChanges(
    sourceWorktreePath: string,
    targetWorktreePath: string
  ): Promise<WorkingTreeCarryResult> {
    return this.runWithGitReadInvalidation(async () => {
      try {
        return normalizeWorkingTreeCarryResult(
          await this.mux.request(
            'git.carryWorkingTreeChanges',
            { sourceWorktreePath, targetWorktreePath },
            { timeoutMs: CARRY_WORKING_TREE_REQUEST_TIMEOUT_MS }
          )
        )
      } catch (error) {
        // Why: a timed-out/lost-connection carry may have written some or all changes on the host (docs/reference/ssh-execution-boundary.md).
        if (isSshRequestOutcomeUnverifiable(error)) {
          return {
            ok: false,
            reason: 'partially_applied',
            detail: error instanceof Error ? error.message : String(error)
          }
        }
        throw error
      }
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

  async getBranchCompare(
    worktreePath: string,
    baseRef: string,
    options: { admissionTier?: GitAdmissionTier } = {}
  ): Promise<GitBranchCompareResult> {
    return (await this.mux.request('git.branchCompare', {
      worktreePath,
      baseRef,
      ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
    })) as GitBranchCompareResult
  }

  async getCommitCompare(worktreePath: string, commitId: string): Promise<GitCommitCompareResult> {
    return (await this.mux.request('git.commitCompare', {
      worktreePath,
      commitId
    })) as GitCommitCompareResult
  }
}
