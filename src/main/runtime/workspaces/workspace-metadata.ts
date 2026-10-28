import { OrcaRuntimeWithCreateManagedWorktree } from './workspace-creation'
import type { LocalGitExecOptions } from '../../git/repo-default-base-ref'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { RemoteFetchResult, RemoteTrackingBase } from '../runtime-remote-fetch-controller'
import type { WorktreeBaseStatusEvent } from '../../../shared/worktree/base-ref-drift-types'
import { probeRuntimeWorktreeDrift } from '../runtime-worktree-drift-probe'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { GitHubPrStartPoint, GitPushTarget } from '../../../shared/worktree/types'
import {
  persistRuntimeManagedWorktreeSortOrder,
  updateRuntimeManagedWorktreeMetadata
} from '../runtime-managed-worktree-metadata'
import { resolveRuntimeGitHubWorktreeBase } from '../runtime-github-worktree-base'
import { resolveRuntimeGitLabWorktreeBase } from '../runtime-gitlab-worktree-base'
import { listWorktreesStrict } from '../../git/worktree-listing'
import {
  adoptRuntimeProvisionedRoot,
  readLocalSparseCheckoutEnabled,
  type RuntimeProvisionedRootRequest
} from '../runtime-provisioned-root-adoption'

export abstract class OrcaRuntimeWithCreateManagedRemoteWorktree extends OrcaRuntimeWithCreateManagedWorktree {
  async getCanonicalFetchKey(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<string> {
    return await this.remoteFetches.getCanonicalFetchKey(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteFetch(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteFetch(repoPath, remote, gitOptions)
  }

  async getOrStartRemoteTrackingBaseRefresh(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteFetchResult> {
    return await this.remoteFetches.getOrStartRemoteTrackingBaseRefresh(repoPath, base, gitOptions)
  }

  async fetchRemoteWithCache(
    repoPath: string,
    remote: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<void> {
    await this.remoteFetches.fetchRemoteWithCache(repoPath, remote, gitOptions)
  }

  async resolveRemoteTrackingBase(
    repoPath: string,
    baseBranch: string,
    gitOptions: LocalGitExecOptions = {}
  ): Promise<RemoteTrackingBase | null> {
    return await this.remoteFetches.resolveRemoteTrackingBase(repoPath, baseBranch, gitOptions)
  }

  async hasRemoteTrackingRef(
    repoPath: string,
    base: RemoteTrackingBase,
    gitOptions: LocalGitExecOptions = {}
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

  /** Null means unknown HEAD drift and permits dispatch; only confirmed staleness refuses (§3.1). */
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

  adoptManagedProvisionedRoot(
    repoSelector: string,
    request: RuntimeProvisionedRootRequest
  ): Promise<CreateWorktreeResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return adoptRuntimeProvisionedRoot(repoSelector, request, {
      store: this.store,
      resolveRepo: (selector) => this.resolveRepoSelector(selector),
      listWorktrees: (repoPath) => listWorktreesStrict(repoPath),
      isSparseCheckoutEnabled: readLocalSparseCheckoutEnabled,
      invalidateScan: (repoId) => {
        this.invalidateResolvedWorktreeCache()
        this.invalidateWorktreeScanCacheForRepo(repoId)
      },
      notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId),
      showWorktree: (selector) => this.showManagedWorktree(selector)
    })
  }

  persistManagedWorktreeSortOrder(
    orderedIds: string[],
    hostIds?: readonly string[]
  ): { updated: number } {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    return persistRuntimeManagedWorktreeSortOrder({
      orderedIds,
      hostIds,
      store: this.store,
      invalidateResolved: () => this.invalidateResolvedWorktreeCache(),
      notifyChanged: (repoId, sortOrders) =>
        this.notifyWorktreesChanged(
          repoId,
          sortOrders
            ? { invalidateGitScans: false, sortOrderOnly: true, sortOrders }
            : { invalidateGitScans: false }
        )
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
