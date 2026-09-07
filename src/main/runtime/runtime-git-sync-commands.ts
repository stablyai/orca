import type { GitForkSyncExpectedUpstream, GitForkSyncResult } from '../../shared/git-fork-sync'
import type { GitUpstreamStatus } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { gitSyncForkDefaultBranch } from '../git/fork-sync'
import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from '../git/remote'
import { abortMerge, abortRebase, commitChanges } from '../git/status'
import { getUpstreamStatus } from '../git/upstream'
import {
  materializeWorktreePushTargetRemote,
  materializeWorktreePushTargetRemoteSsh
} from '../ipc/worktree-remote'
import {
  localGitOptionsForTarget,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost,
  type RuntimeGitTarget
} from './runtime-git-command-target'

export class RuntimeGitSyncCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  // Why (#17828 review follow-up): this class deliberately materializes with no store (see
  // the `undefined` args below) to avoid unrelated ownership-inheritance/refspec-migration
  // side effects on the RPC path -- so persistence goes through the host callback instead,
  // using `target.worktree.id` already resolved here rather than threading a store through.
  private persistMaterializedPushTargetIfCreated(
    target: RuntimeGitTarget,
    materialized: GitPushTarget | undefined
  ): void {
    if (materialized?.remoteCreated) {
      this.host.persistMaterializedPushTarget?.(target.worktree.id, materialized)
    }
  }

  async abortRuntimeGitMerge(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.abortMerge(target.worktree.path)
      return { ok: true }
    }
    await abortMerge(target.worktree.path, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async abortRuntimeGitRebase(worktreeSelector: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.abortRebase(target.worktree.path)
      return { ok: true }
    }
    await abortRebase(target.worktree.path, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async getRuntimeGitUpstreamStatus(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<GitUpstreamStatus> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      return provider.getUpstreamStatus(target.worktree.path, pushTarget)
    }
    return getUpstreamStatus(target.worktree.path, pushTarget, localGitOptionsForTarget(target))
  }

  async fetchRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      const materializedPushTarget = pushTarget
        ? await materializeWorktreePushTargetRemoteSsh(provider, target.worktree.path, pushTarget)
        : undefined
      this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
      await provider.fetchRemote(target.worktree.path, materializedPushTarget)
      return { ok: true }
    }
    const materializedPushTarget = pushTarget
      ? await materializeWorktreePushTargetRemote(
          target.worktree.path,
          pushTarget,
          undefined,
          target.repo?.id,
          localGitOptionsForTarget(target)
        )
      : undefined
    this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
    await gitFetch(target.worktree.path, materializedPushTarget, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async syncRuntimeGitForkDefaultBranch(
    worktreeSelector: string,
    expectedUpstream: GitForkSyncExpectedUpstream
  ): Promise<GitForkSyncResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      return provider.syncForkDefaultBranch(target.worktree.path, expectedUpstream)
    }
    return gitSyncForkDefaultBranch(target.worktree.path, expectedUpstream, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
  }

  async pullRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      const materializedPushTarget = pushTarget
        ? await materializeWorktreePushTargetRemoteSsh(provider, target.worktree.path, pushTarget)
        : undefined
      this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
      await provider.pullBranch(target.worktree.path, materializedPushTarget)
      return { ok: true }
    }
    const materializedPushTarget = pushTarget
      ? await materializeWorktreePushTargetRemote(
          target.worktree.path,
          pushTarget,
          undefined,
          target.repo?.id,
          localGitOptionsForTarget(target)
        )
      : undefined
    this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
    await gitPull(target.worktree.path, materializedPushTarget, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async fastForwardRuntimeGit(
    worktreeSelector: string,
    pushTarget?: GitPushTarget
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      const materializedPushTarget = pushTarget
        ? await materializeWorktreePushTargetRemoteSsh(provider, target.worktree.path, pushTarget)
        : undefined
      this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
      await provider.fastForwardBranch(target.worktree.path, materializedPushTarget)
      return { ok: true }
    }
    const materializedPushTarget = pushTarget
      ? await materializeWorktreePushTargetRemote(
          target.worktree.path,
          pushTarget,
          undefined,
          target.repo?.id,
          localGitOptionsForTarget(target)
        )
      : undefined
    this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
    await gitFastForward(target.worktree.path, materializedPushTarget, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async rebaseRuntimeGitFromBase(worktreeSelector: string, baseRef: string): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      await provider.rebaseFromBase(target.worktree.path, baseRef)
      return { ok: true }
    }
    await gitPullRebaseFromBase(target.worktree.path, baseRef, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
    return { ok: true }
  }

  async pushRuntimeGit(
    worktreeSelector: string,
    publish?: boolean,
    pushTarget?: GitPushTarget,
    forceWithLease?: boolean
  ): Promise<{ ok: true }> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      const materializedPushTarget = pushTarget
        ? await materializeWorktreePushTargetRemoteSsh(provider, target.worktree.path, pushTarget)
        : undefined
      this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
      await provider.pushBranch(target.worktree.path, publish === true, materializedPushTarget, {
        forceWithLease: forceWithLease === true
      })
      return { ok: true }
    }
    const materializedPushTarget = pushTarget
      ? await materializeWorktreePushTargetRemote(
          target.worktree.path,
          pushTarget,
          undefined,
          target.repo?.id,
          localGitOptionsForTarget(target)
        )
      : undefined
    this.persistMaterializedPushTargetIfCreated(target, materializedPushTarget)
    await gitPush(target.worktree.path, publish === true, materializedPushTarget, {
      forceWithLease: forceWithLease === true,
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
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
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      return provider.commit(target.worktree.path, message)
    }
    return commitChanges(target.worktree.path, message, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
  }
}
