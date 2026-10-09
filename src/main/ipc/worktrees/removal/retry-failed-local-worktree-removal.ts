import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { retryFailedWorktreeRemoval } from '../../../worktree-background-removal'
import { interruptedLocalWorktreeRemovalJob } from '../../../runtime/runtime-interrupted-local-worktree-removal'
import { invalidateAuthorizedRootsCacheForRepo } from '../../registered-worktree-roots-scoped-invalidation'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  preserveBranchHeadFallback,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import {
  removeWorktreeMetadataAndTransientState,
  stopPtysForDestructiveWorktreeRemoval
} from './worktree-removal-ownership'

/**
 * Delete on the leftover of a local delete that failed after Git dropped the registration: runs the
 * recorded removal again with this handler's bookkeeping. Undefined when there is none.
 */
export function retryFailedLocalWorktreeRemoval(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  removalHostId: ExecutionHostId
): Promise<RemoveWorktreeResult> | undefined {
  const { store, runtime, options } = context
  return retryFailedWorktreeRemoval(args.worktreeId, removalHostId, (record) =>
    interruptedLocalWorktreeRemovalJob(record, {
      store,
      acquireWatcherRemoval: (path) => runtime.acquireFileWatcherRemoval(path),
      closeWatchers: (path) => runtime.closeFileWatchersForRemoval(path),
      stopPtys: () =>
        stopPtysForDestructiveWorktreeRemoval(runtime, record.worktreeId, {
          allowUnverifiedStop: args.allowUnverifiedPtyStop
        }),
      preservedBranchCleanup: {
        preserveHead: preserveBranchHeadFallback,
        remember: (worktreeId, _hostId, result, fallbackHead, pushTarget) =>
          rememberPreservedBranchCleanupTarget(
            worktreeId,
            LOCAL_EXECUTION_HOST_ID,
            result,
            fallbackHead,
            pushTarget
          )
      },
      purge: ({ worktreeId, repoId }) => {
        runtime.clearOptimisticReconcileToken(worktreeId)
        removeWorktreeMetadataAndTransientState(
          store,
          worktreeId,
          LOCAL_EXECUTION_HOST_ID,
          args.snapshotPruneBatchId
        )
        invalidateAuthorizedRootsCacheForRepo(store, repoId)
      },
      onRemoved: ({ worktreeId, worktreePath }) =>
        options?.onWorktreeLifecycle?.({ kind: 'removed', worktreeId, path: worktreePath }),
      publish: (repoId) => runtime.publishWorktreeRemovalChange(repoId)
    })
  )
}
