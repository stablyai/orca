import { defineMethod } from '../core'
import { resolveWorktreeCatalogSnapshot } from '../worktree-catalog-snapshot'
import { supportsWorktreeVisibilitySourceDefaults } from '../worktree-visibility-client-capability'
import {
  projectWorktreeListRemovals,
  projectWorktreePsRemovals
} from '../worktree-removal-marker-projection'
import { snapshotPendingWorktreeRemovals } from '../../../worktree-background-removal'
import {
  WorktreeDetectedListParams,
  WorktreeListParams,
  WorktreePsParams
} from './worktree-schemas'

export const WORKTREE_CATALOG_METHODS = [
  defineMethod({
    name: 'worktree.ps',
    params: WorktreePsParams,
    handler: async (params, context) => {
      const pendingAtScan = snapshotPendingWorktreeRemovals()
      const result = projectWorktreePsRemovals(
        await context.runtime.getWorktreePs(
          params.limit,
          supportsWorktreeVisibilitySourceDefaults(
            context,
            params.supportsWorktreeVisibilitySourceDefaults
          )
        ),
        context,
        pendingAtScan
      )
      // Why: callers that never send the field get the byte-exact legacy response.
      return params.afterSnapshotId === undefined
        ? result
        : resolveWorktreeCatalogSnapshot(result, params.afterSnapshotId)
    }
  }),
  defineMethod({
    name: 'worktree.list',
    params: WorktreeListParams,
    handler: async (params, context) => {
      const pendingAtScan = snapshotPendingWorktreeRemovals()
      return projectWorktreeListRemovals(
        await context.runtime.listManagedWorktrees(
          params.repo,
          params.limit,
          supportsWorktreeVisibilitySourceDefaults(context)
        ),
        context,
        pendingAtScan
      )
    }
  }),
  defineMethod({
    name: 'worktree.listRetiredNames',
    params: WorktreeDetectedListParams,
    handler: async (params, { runtime }) => runtime.listRetiredWorktreeNames(params.repo)
  }),
  defineMethod({
    name: 'worktree.detectedList',
    params: WorktreeDetectedListParams,
    handler: async (params, context) => {
      const pendingAtScan = snapshotPendingWorktreeRemovals()
      return projectWorktreeListRemovals(
        await context.runtime.listDetectedManagedWorktrees(
          params.repo,
          undefined,
          supportsWorktreeVisibilitySourceDefaults(context)
        ),
        context,
        pendingAtScan
      )
    }
  })
]
