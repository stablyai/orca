import type { GitForkSyncExpectedUpstream, GitForkSyncResult } from '../../shared/git-fork-sync'
import type { GitPushTarget } from '../../shared/worktree/types'
import { REBASE_FROM_BASE_RPC_TIMEOUT_MS } from '../../shared/git-rebase-source'
import { SshGitWorkingTreeProvider } from './ssh-git-working-tree-provider'

export class SshGitRemoteSyncProvider extends SshGitWorkingTreeProvider {
  async pushBranch(
    worktreePath: string,
    publish = false,
    pushTarget?: GitPushTarget,
    options: { forceWithLease?: boolean } = {}
  ): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.push', {
        worktreePath,
        publish,
        pushTarget,
        ...(options.forceWithLease === true ? { forceWithLease: true } : {})
      })
    })
  }

  async pullBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.pull', { worktreePath, ...(pushTarget ? { pushTarget } : {}) })
    })
  }

  async fastForwardBranch(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.fastForward', {
        worktreePath,
        ...(pushTarget ? { pushTarget } : {})
      })
    })
  }

  async rebaseFromBase(worktreePath: string, baseRef: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request(
        'git.rebaseFromBase',
        { worktreePath, baseRef },
        { timeoutMs: REBASE_FROM_BASE_RPC_TIMEOUT_MS }
      )
    })
  }

  async fetchRemote(worktreePath: string, pushTarget?: GitPushTarget): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.fetch', { worktreePath, ...(pushTarget ? { pushTarget } : {}) })
    })
  }

  async syncForkDefaultBranch(
    worktreePath: string,
    expectedUpstream: GitForkSyncExpectedUpstream
  ): Promise<GitForkSyncResult> {
    return this.runWithGitReadInvalidation(
      async () =>
        (await this.mux.request('git.forkSync', {
          worktreePath,
          ...(expectedUpstream ? { expectedUpstream } : {})
        })) as GitForkSyncResult
    )
  }

  async fetchRemoteTrackingRef(
    worktreePath: string,
    remote: string,
    branch: string,
    ref: string,
    options?: { skipAutoMaintenance?: boolean }
  ): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.fetchRemoteTrackingRef', {
        worktreePath,
        remote,
        branch,
        ref,
        ...(options?.skipAutoMaintenance ? { skipAutoMaintenance: true } : {})
      })
    })
  }
}
