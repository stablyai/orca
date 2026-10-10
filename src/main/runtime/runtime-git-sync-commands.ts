import type { GitForkSyncExpectedUpstream, GitForkSyncResult } from '../../shared/git-fork-sync'
import type { GitUpstreamStatus } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  materializeWorktreePushTargetRemote,
  materializeWorktreePushTargetRemoteSsh
} from '../ipc/worktree-remote'
import type { LocalGitProvider } from '../providers/local-git-provider'
import {
  localGitOptionsForTarget,
  requireRuntimeGitProvider,
  requireSshRuntimeGitProvider,
  runtimeGitRouteForTarget,
  type RuntimeGitCommandHost,
  type RuntimeGitTarget
} from './runtime-git-command-target'

export class RuntimeGitSyncCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  /**
   * Resolves the provider and mints the push target's remote on the worktree's host.
   *
   * Why (#17828 review follow-up): this class deliberately materializes with no store (see the
   * `undefined` arg below) to avoid unrelated ownership-inheritance/refspec-migration side effects
   * on the RPC path -- so persistence goes through the host callback instead, using
   * `target.worktree.id` already resolved here rather than threading a store through.
   */
  private async prepareRemoteSync(
    target: RuntimeGitTarget,
    pushTarget: GitPushTarget | undefined
  ): Promise<{ provider: LocalGitProvider; pushTarget: GitPushTarget | undefined }> {
    const route = runtimeGitRouteForTarget(target)
    let provider: LocalGitProvider
    let materialized: GitPushTarget | undefined
    if (route.kind === 'ssh') {
      const sshProvider = requireSshRuntimeGitProvider(route)
      provider = sshProvider
      materialized = pushTarget
        ? await materializeWorktreePushTargetRemoteSsh(
            sshProvider,
            target.worktree.path,
            pushTarget
          )
        : undefined
    } else {
      provider = requireRuntimeGitProvider(target, route)
      materialized = pushTarget
        ? await materializeWorktreePushTargetRemote(
            target.worktree.path,
            pushTarget,
            undefined,
            target.repo?.id,
            localGitOptionsForTarget(target)
          )
        : undefined
    }
    if (materialized?.remoteCreated) {
      this.host.persistMaterializedPushTarget?.(target.worktree.id, materialized)
    }
    return { provider, pushTarget: materialized }
  }

  async abortRuntimeGitMerge(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    await requireRuntimeGitProvider(target).abortMerge(target.worktree.path)
    return { ok: true }
  }

  async abortRuntimeGitRebase(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    await requireRuntimeGitProvider(target).abortRebase(target.worktree.path)
    return { ok: true }
  }

  async getRuntimeGitUpstreamStatus(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<GitUpstreamStatus> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).getUpstreamStatus(target.worktree.path, pushTarget)
  }

  async fetchRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const sync = await this.prepareRemoteSync(target, pushTarget)
    await sync.provider.fetchRemote(target.worktree.path, sync.pushTarget)
    return { ok: true }
  }

  async syncRuntimeGitForkDefaultBranch(
    worktreeSelector: string,
    expectedUpstream: GitForkSyncExpectedUpstream
  ): Promise<GitForkSyncResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).syncForkDefaultBranch(
      target.worktree.path,
      expectedUpstream
    )
  }

  async pullRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const sync = await this.prepareRemoteSync(target, pushTarget)
    await sync.provider.pullBranch(target.worktree.path, sync.pushTarget)
    return { ok: true }
  }

  async fastForwardRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const sync = await this.prepareRemoteSync(target, pushTarget)
    await sync.provider.fastForwardBranch(target.worktree.path, sync.pushTarget)
    return { ok: true }
  }

  async rebaseRuntimeGitFromBase(worktreeSelector: string, baseRef: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    await requireRuntimeGitProvider(target).rebaseFromBase(target.worktree.path, baseRef)
    return { ok: true }
  }

  async pushRuntimeGit(
    worktreeSelector: string,
    publish?: boolean,
    pushTarget?: GitPushTarget,
    forceWithLease?: boolean
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const sync = await this.prepareRemoteSync(target, pushTarget)
    await sync.provider.pushBranch(target.worktree.path, publish === true, sync.pushTarget, {
      forceWithLease: forceWithLease === true
    })
    return { ok: true }
  }

  async commitRuntimeGit(
    worktreeSelector: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    if (message.trim().length === 0) {
      throw new Error('Commit message is required')
    }
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    return requireRuntimeGitProvider(target).commit(target.worktree.path, message)
  }
}
