import type { GitStatusResult } from '../../shared/git-status-types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'
import { SshGitReviewHeadProvider } from './ssh-git-review-head-provider'

function formatStatusEntriesForCleanCheck(entries: GitStatusResult['entries']): string | undefined {
  if (entries.length === 0) {
    return undefined
  }
  return entries.map((entry) => `${entry.area} ${entry.status}: ${entry.path}`).join('\n')
}

function filterUntrackedPorcelainStatus(stdout: string | undefined): string | undefined {
  const trackedLines = (stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith('?? '))
  return trackedLines.length > 0 ? trackedLines.join('\n') : undefined
}

export class SshGitWorktreeProvider extends SshGitReviewHeadProvider {
  private loggedWorktreeIsCleanFallback = false

  async listWorktrees(
    repoPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<GitWorktreeInfo[]> {
    return (await this.mux.request(
      'git.listWorktrees',
      { repoPath },
      { signal: options?.signal }
    )) as GitWorktreeInfo[]
  }

  async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; checkoutExistingBranch?: boolean; noCheckout?: boolean }
  ): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.addWorktree', {
        repoPath,
        branchName,
        targetDir,
        ...options
      })
    })
  }

  async removeWorktree(
    worktreePath: string,
    force?: boolean,
    options?: { deleteBranch?: boolean; forceBranchDelete?: boolean }
  ): Promise<RemoveWorktreeResult> {
    return this.runWithGitReadInvalidation(
      async () =>
        ((await this.mux.request('git.removeWorktree', {
          worktreePath,
          force,
          ...options
        })) ?? {}) as RemoveWorktreeResult
    )
  }

  async worktreeIsClean(
    worktreePath: string,
    options: { includeUntracked?: boolean } = {}
  ): Promise<{ clean: boolean; stdout?: string }> {
    try {
      const result = (await this.mux.request('git.worktreeIsClean', {
        worktreePath,
        ...(options.includeUntracked === false ? { includeUntracked: false } : {})
      })) as { clean: boolean; stdout?: string }
      if (options.includeUntracked === false) {
        if (!result.clean && result.stdout === undefined) {
          return result
        }
        const trackedStdout = filterUntrackedPorcelainStatus(result.stdout)
        return { clean: !trackedStdout, ...(trackedStdout ? { stdout: trackedStdout } : {}) }
      }
      return result
    } catch (error) {
      if (!isJsonRpcMethodNotFoundError(error)) {
        throw error
      }
      if (!this.loggedWorktreeIsCleanFallback) {
        this.loggedWorktreeIsCleanFallback = true
        console.warn(
          '[ssh-git] Relay does not implement git.worktreeIsClean; falling back to git.status clean check'
        )
      }
      const status = await this.getStatus(worktreePath)
      const entries =
        options.includeUntracked === false
          ? status.entries.filter((entry) => entry.area !== 'untracked')
          : status.entries
      const clean = entries.length === 0
      return { clean, stdout: formatStatusEntriesForCleanCheck(entries) }
    }
  }

  async refreshLocalBaseRefForWorktreeCreate(args: {
    repoPath: string
    fullRef: string
    remoteTrackingRef: string
    ownerWorktreePath?: string
    checkOnly?: boolean
  }): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.refreshLocalBaseRefForWorktreeCreate', args)
    })
  }

  async renameCurrentBranch(worktreePath: string, newBranch: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.renameCurrentBranch', { worktreePath, newBranch })
    })
  }

  async forceDeletePreservedBranch(
    repoPath: string,
    branchName: string,
    expectedHead: string
  ): Promise<void> {
    try {
      await this.runWithGitReadInvalidation(async () => {
        await this.mux.request('git.forceDeletePreservedBranch', {
          repoPath,
          branchName,
          expectedHead
        })
      })
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new Error(
          'This SSH host is running an older Orca relay that cannot delete preserved branches. Reconnect to deploy the latest relay, then try again.'
        )
      }
      throw error
    }
  }
}
