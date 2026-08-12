import { defineMethod } from '../core'
import { WorktreeReleasePreservedBranchCleanups } from './worktree-schemas'

export const WORKTREE_PRESERVED_CLEANUP_RELEASE_METHOD = defineMethod({
  name: 'worktree.releasePreservedBranchCleanups',
  params: WorktreeReleasePreservedBranchCleanups,
  handler: async (params, { runtime }) =>
    runtime.releasePreservedBranchCleanups(
      params.cleanups.map((cleanup) => ({
        ...(cleanup.cleanupId ? { cleanupId: cleanup.cleanupId } : {}),
        worktreeSelector: cleanup.worktree,
        branchName: cleanup.branchName,
        expectedHead: cleanup.expectedHead,
        hostId: cleanup.hostId
      }))
    )
})
