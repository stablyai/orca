import type {
  RemoteFetchResult,
  RemoteTrackingBase
} from '../repositories/runtime-remote-fetch-controller'
import type { WorktreeBaseStatusEvent } from '../../../shared/worktree/base-ref-drift-types'
import { probeRuntimeWorktreeDrift } from './metadata/runtime-worktree-drift-probe'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../../shared/worktree/types'
import {
  persistRuntimeManagedWorktreeSortOrder,
  updateRuntimeManagedWorktreeMetadata
} from './metadata/runtime-managed-worktree-metadata'
import { RuntimeWorktreeReviewBase } from './metadata/runtime-worktree-review-base'

export abstract class RuntimeWorkspaceMetadata extends RuntimeWorktreeReviewBase {
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
      resolveWorktree: (selector) => this.resolveGitWorktreeSelector(selector),
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
        resolveWorktree: (selector) => this.resolveGitWorktreeSelector(selector),
        validateParent: (worktree, parent) => this.worktreeLineage.validateParent(worktree, parent),
        invalidateResolved: () => this.invalidateResolvedWorktreeCache(),
        invalidateScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
        notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId),
        showWorktree: (selector) => this.showManagedWorktree(selector)
      }
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
}
