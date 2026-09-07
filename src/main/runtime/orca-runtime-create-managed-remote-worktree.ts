// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateManagedWorktree } from './orca-runtime-create-managed-worktree'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeRemoteWorktreeCreateArgs } from './runtime-remote-worktree-create-request'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { createRuntimeRemoteManagedWorktree } from './runtime-remote-managed-worktree-create'
import type { RemoteFetchResult, RemoteTrackingBase } from './runtime-remote-fetch-controller'
import type { WorktreeBaseStatusEvent } from '../../shared/worktree/base-ref-drift-types'
import { probeRuntimeWorktreeDrift } from './runtime-worktree-drift-probe'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitHubPrStartPoint, GitPushTarget } from '../../shared/worktree/types'
import {
  persistRuntimeManagedWorktreeSortOrder,
  updateRuntimeManagedWorktreeMetadata
} from './runtime-managed-worktree-metadata'
import { resolveRuntimeGitHubWorktreeBase } from './runtime-github-worktree-base'
import { resolveRuntimeGitLabWorktreeBase } from './runtime-gitlab-worktree-base'

export class OrcaRuntimeWithCreateManagedRemoteWorktree extends OrcaRuntimeWithCreateManagedWorktree {
  protected createManagedRemoteWorktree(
    repo: Repo,
    args: RuntimeRemoteWorktreeCreateArgs
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return createRuntimeRemoteManagedWorktree(repo, args, {
      store: this.store,
      canSpawn: () => Boolean(this.ptyController?.spawn),
      markTrusted: (agent, connectionId, path) =>
        this.markRemoteWorkspaceTrustedForAgent(agent, connectionId, path),
      createTerminal: (selector, options) => this.createTerminal(selector, options),
      pasteDraft: (handle, draft) => this.pasteStartupDraftWhenReady(handle, draft),
      sendFollowup: (handle, followup) => this.sendStartupFollowupWhenReady(handle, followup),
      provision: (options) => this.provisionManagedWorktreeTerminals(options),
      activate: (repoId, worktreeId, setup, startup, defaultTabs) =>
        this.notifyActivateWorktree(
          repoId,
          worktreeId,
          setup,
          startup,
          defaultTabs,
          args.navigation
        ),
      invalidateResolvedWorktrees: () => this.invalidateResolvedWorktreeCache(),
      invalidateWorktreeScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
      notifyWorktreesChanged: (repoId) => this.notifyWorktreesChanged(repoId)
    })
  }

  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<string> {
    return await this.remoteFetches.getCanonicalFetchKey(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteTrackingBaseRefresh(repoPath, base, gitOptions)
  }

  async fetchRemoteWithCache(
    repoPath: string,
    remote: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<void> {
    await this.remoteFetches.fetchRemoteWithCache(repoPath, remote, gitOptions)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<RemoteTrackingBase | null> {
    return await this.remoteFetches.resolveRemoteTrackingBase(repoPath, baseBranch, gitOptions)
  }

  async hasRemoteTrackingRef(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: { wslDistro?: string } = {}
  ): Promise<boolean> {
    return await this.remoteFetches.hasRemoteTrackingRef(repoPath, base, gitOptions)
  }

  recordOptimisticReconcileToken(worktreeId: string): string {
    return this.worktreeBaseReconciliation.recordToken(worktreeId)
  }

  clearOptimisticReconcileToken(worktreeId: string): void {
    this.worktreeBaseReconciliation.clearToken(worktreeId)
  }

  emitWorktreeBaseStatus(event: WorktreeBaseStatusEvent): void {
    this.worktreeBaseReconciliation.emitStatus(event)
  }

  async reconcileWorktreeBaseStatus(args: {
    repoId: string
    repoPath: string
    worktreeId: string
    base: RemoteTrackingBase
    branchName: string
    createdBaseSha: string
    token: string
    fetchPromise: Promise<RemoteFetchResult>
  }): Promise<void> {
    await this.worktreeBaseReconciliation.reconcile(args)
  }

  /**
   * Probe how far the worktree's HEAD is behind its tracking remote. Returns
   * null when the probe cannot establish a signal (no default base ref, or
   * git failure). Dispatch treats null as "unknown — proceed" (§3.1); only
   * knowing-and-stale refuses.
   */
  async probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null> {
    return probeRuntimeWorktreeDrift({
      selector: worktreeSelector,
      store: this.store ? this.requireStore() : null,
      resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
      resolveRemoteTrackingBase: (repoPath, base, options) =>
        this.resolveRemoteTrackingBase(repoPath, base, options),
      fetchRemote: (repoPath, remote, options) =>
        this.fetchRemoteWithCache(repoPath, remote, options)
    })
  }

  async updateManagedWorktreeMeta(
    worktreeSelector: string,
    updates: Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
      pushTarget?: GitPushTarget | null
      lineage?: {
        parentWorktree?: string
        noParent?: boolean
      }
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return updateRuntimeManagedWorktreeMetadata({
      selector: worktreeSelector,
      updates,
      store: this.store,
      ports: {
        resolveWorktree: (selector) => this.resolveWorktreeSelector(selector),
        validateParent: (worktree, parent) => this.worktreeLineage.validateParent(worktree, parent),
        invalidateResolved: () => this.invalidateResolvedWorktreeCache(),
        invalidateScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
        notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId),
        showWorktree: (selector) => this.showManagedWorktree(selector)
      }
    })
  }

  persistManagedWorktreeSortOrder(orderedIds: string[]): { updated: number } {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return persistRuntimeManagedWorktreeSortOrder({
      orderedIds,
      store: this.store,
      invalidateResolved: () => this.invalidateResolvedWorktreeCache(),
      notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId)
    })
  }

  async resolveManagedPrBase(args: {
    repoSelector: string
    prNumber: number
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  }): Promise<GitHubPrStartPoint | { error: string }> {
    return resolveRuntimeGitHubWorktreeBase(args, {
      store: this.store ? this.requireStore() : null,
      resolveRepo: (selector) => this.resolveRepoSelector(selector)
    })
  }

  async resolveManagedMrBase(args: {
    repoSelector: string
    mrIid: number
    sourceBranch?: string
    targetBranch?: string
    isCrossRepository?: boolean
  }): Promise<
    { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget } | { error: string }
  > {
    return resolveRuntimeGitLabWorktreeBase(args, {
      store: this.store ? this.requireStore() : null,
      resolveRepo: (selector) => this.resolveRepoSelector(selector)
    })
  }
}
