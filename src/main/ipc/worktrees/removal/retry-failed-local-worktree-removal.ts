import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { retryFailedWorktreeRemoval } from '../../../workspaces/removal/worktree-background-removal'
import { interruptedLocalWorktreeRemovalJob } from '../../../runtime/workspaces/removal/runtime-interrupted-local-worktree-removal'
import { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'
import {
  preserveBranchHeadFallback,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import {
  removeWorktreeMetadataAndTransientState,
  stopPtysForDestructiveWorktreeRemoval
} from './worktree-removal-ownership'
import { worktreeHostIdentity } from '../../../persistence/worktree-meta-host-identity'

/** Retry recorded leftovers after Git deregistration, retaining IPC bookkeeping; return undefined if none exist. */
export function retryFailedLocalWorktreeRemoval(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  removalHostId: ExecutionHostId
): Promise<RemoveWorktreeResult> | undefined {
  const { store, runtime, options } = context
  const purgedIdentities = new Map<string, ReturnType<typeof worktreeHostIdentity>>()
  const jobFor = (record: WorktreeRemovalRecord) =>
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
        // `removed` is heard after this drops the row, so its identity is read first.
        purgedIdentities.set(
          worktreeId,
          worktreeHostIdentity(store, worktreeId, LOCAL_EXECUTION_HOST_ID)
        )
        runtime.clearOptimisticReconcileToken(worktreeId)
        removeWorktreeMetadataAndTransientState(
          { store, runtime },
          worktreeId,
          LOCAL_EXECUTION_HOST_ID,
          args.snapshotPruneBatchId
        )
        invalidateAuthorizedRootsCacheForRepo(store, repoId)
      },
      onRemoved: ({ worktreeId, worktreePath }) => {
        const identity = purgedIdentities.get(worktreeId)
        purgedIdentities.delete(worktreeId)
        options?.onWorktreeLifecycle?.({
          kind: 'removed',
          worktreeId,
          path: worktreePath,
          ...identity
        })
      },
      publish: (repoId) => runtime.publishWorktreeRemovalChange(repoId)
    })
  return retryFailedWorktreeRemoval(args.worktreeId, removalHostId, jobFor, args.force ?? false)
}
