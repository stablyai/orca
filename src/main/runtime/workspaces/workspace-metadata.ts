import type {
  RemoteFetchResult,
  RemoteTrackingBase
} from '../repositories/runtime-remote-fetch-controller'
import type { WorktreeBaseStatusEvent } from '../../../shared/worktree/base-refs/base-ref-drift-types'
import { probeRuntimeWorktreeDrift } from './metadata/runtime-worktree-drift-probe'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../../shared/worktree/types'
import {
  persistRuntimeManagedWorktreeSortOrder,
  updateRuntimeManagedWorktreeMetadata
} from './metadata/runtime-managed-worktree-metadata'
import type { CrossStoreParentRef } from '../../../shared/worktree/lineage-types'
import { RuntimeWorktreeReviewBase } from './metadata/runtime-worktree-review-base'
import type { WorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../../shared/workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

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
        matchFolderWorkspaces?: boolean
        crossStoreParent?: CrossStoreParentRef
        noParent?: boolean
      }
    }
  ) {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    // A folder workspace's only lineage is its workspace link; other fields stay git-only as before.
    const { lineage, ...rest } = updates
    const folder =
      lineage?.noParent === true && Object.values(rest).every((value) => value === undefined)
        ? this.resolveFolderWorkspaceSelector(worktreeSelector)
        : null
    if (folder) {
      const folderKey = folderWorkspaceKey(folder.id)
      this.store.removeWorkspaceLineage?.((link) => link.childWorkspaceKey === folderKey)
      this.invalidateResolvedWorktreeCache()
      this.notifyFolderWorkspaceChanged()
      return this.showManagedWorktree(worktreeSelector)
    }
    return updateRuntimeManagedWorktreeMetadata({
      selector: worktreeSelector,
      updates,
      store: this.store,
      ports: {
        resolveWorktree: (selector) => this.resolveGitWorktreeSelector(selector),
        resolveParent: (selector, options) => this.worktreeLineage.resolveParent(selector, options),
        validateParent: (worktree, parent) => this.worktreeLineage.validateParent(worktree, parent),
        readStoreInstallationId: () => this.worktreeLineage.readStoreInstallationId(),
        invalidateResolved: () => this.invalidateResolvedWorktreeCache(),
        invalidateScan: (repoId) => this.invalidateWorktreeScanCacheForRepo(repoId),
        notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId),
        showWorktree: (selector) => this.showManagedWorktree(selector)
      }
    })
  }

  /** Drops every link under a deleted bot's home on this host: same-store ones, and ones to a home on
   *  the computer `homeInstallationId` names. */
  releaseBotHome(botHomeKey: WorkspaceKey, homeInstallationId?: string): { released: number } {
    const store = this.requireStore()
    const released = [
      ...(store.removeWorkspaceLineage?.((lineage) => lineage.parentWorkspaceKey === botHomeKey) ??
        []),
      ...(homeInstallationId
        ? (store.removeCrossStoreWorkspaceLineage?.(
            ({ parent }) =>
              parent.workspaceKey === botHomeKey && parent.installationId === homeInstallationId
          ) ?? [])
        : [])
    ]
    if (released.length === 0) {
      return { released: 0 }
    }
    this.invalidateResolvedWorktreeCache()
    this.notifyFolderWorkspaceChanged()
    const repoIds = new Set(
      released.flatMap((key) => {
        const parsed = parseWorkspaceKey(key)
        return parsed?.type === 'worktree' ? [getRepoIdFromWorktreeId(parsed.worktreeId)] : []
      })
    )
    for (const repoId of repoIds) {
      this.notifyWorktreesChanged(repoId)
    }
    return { released: released.length }
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
