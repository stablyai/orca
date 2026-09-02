import type { GitStatusResult } from '../../shared/git-status-types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { CapabilityProbeCache } from '../../shared/capability-probe-cache'
import { assertAuthoritativeWorktreeCatalog } from '../../shared/worktree/worktree-catalog-availability'
import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'
import { SshGitReviewHeadProvider } from './ssh-git-review-head-provider'

const WORKTREE_IS_CLEAN_CAPABILITY = 'git.worktreeIsClean' as const

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
  private loggedMarkRemoteOrcaCreatedFallback = false
  // Why: reconnect replaces this provider, so an upgraded relay is naturally re-probed.
  private readonly worktreeIsCleanCapabilityCache = new CapabilityProbeCache<
    typeof WORKTREE_IS_CLEAN_CAPABILITY
  >(Number.POSITIVE_INFINITY)

  async listWorktrees(
    repoPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<GitWorktreeInfo[]> {
    const response = await this.mux.request(
      'git.listWorktrees',
      { repoPath },
      { signal: options?.signal }
    )
    // Why (#14004): relays before this fix answered a failed worktree scan with `[]`. Mixed versions are
    // normal, so refuse the shape here too — a Git repo always lists its own checkout.
    return assertAuthoritativeWorktreeCatalog<GitWorktreeInfo>(response, repoPath)
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
    return this.worktreeIsCleanCapabilityCache.runWithFallback(
      WORKTREE_IS_CLEAN_CAPABILITY,
      async () => {
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
      },
      async () => {
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
      },
      isJsonRpcMethodNotFoundError
    )
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

  // Why: git.exec blocks config writes outright, so the deferred fork-remote provenance
  // marker (#17828) needs its own RPC. Non-essential to push/pull, so an older relay
  // that hasn't shipped it yet degrades to no marker rather than failing materialization.
  async markRemoteOrcaCreated(repoPath: string, remoteName: string): Promise<void> {
    try {
      await this.mux.request('git.markRemoteOrcaCreated', { repoPath, remoteName })
    } catch (error) {
      if (!isJsonRpcMethodNotFoundError(error)) {
        throw error
      }
      if (!this.loggedMarkRemoteOrcaCreatedFallback) {
        this.loggedMarkRemoteOrcaCreatedFallback = true
        console.warn(
          "[ssh-git] Relay does not implement git.markRemoteOrcaCreated; this remote will lack a git-config provenance marker permanently (reconnecting does not retroactively add it -- only a newer relay deployment does, for remotes added after that). The store's remoteCreated flag remains the fallback ownership signal for cleanup."
        )
      }
    }
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
