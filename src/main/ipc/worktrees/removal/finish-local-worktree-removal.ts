import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { usesNativeWindowsRemoval } from '../../../git/windows-worktree-removal'
import { pruneGitWorktrees } from '../../../git/worktree-prune-guard'
import { removeWorktree } from '../../../git/worktree'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../local-orphaned-worktree-cleanup'
import { recoverPartialLocalWorktreeRemoval } from '../../../local-worktree-removal-recovery'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { invalidateAuthorizedRootsCacheForRepo } from '../../registered-worktree-roots-scoped-invalidation'
import { runWorktreeChangeInvalidators } from '../../worktree-change-invalidators'
import { formatWorktreeRemovalError, isOrphanedWorktreeError } from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  preserveBranchHeadFallback,
  preservedBranchCleanupByScope,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'

export async function finishLocalWorktreeRemoval({
  context,
  args,
  repo,
  repoId,
  canonicalWorktreePath,
  removalHostId,
  removedPushTarget,
  localWorktreeGitOptions,
  hasLocalWorktreeGitOptions,
  deleteBranch,
  refreshedRegisteredWorktree,
  removalGate,
  checkoutDeleteSignal,
  cleanupPushTarget
}: {
  context: WorktreeIpcContext
  args: RemoveWorktreeArgs
  repo: Repo
  repoId: string
  canonicalWorktreePath: string
  removalHostId: ExecutionHostId
  removedPushTarget: GitPushTarget | undefined
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
  hasLocalWorktreeGitOptions: boolean
  deleteBranch: boolean
  refreshedRegisteredWorktree: GitWorktreeInfo
  removalGate: { finish: (removed: boolean) => Promise<void> }
  checkoutDeleteSignal?: AbortSignal
  cleanupPushTarget: () => Promise<void>
}): Promise<RemoveWorktreeResult> {
  const { store, runtime } = context
  let removalResult: RemoveWorktreeResult | undefined
  let removalCompleted = false
  try {
    try {
      const removeOptions = {
        ...(!deleteBranch ? { deleteBranch } : {}),
        // Reuse the authoritative listing instead of rescanning siblings during deletion.
        knownRemovedWorktree: refreshedRegisteredWorktree,
        ...(hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {}),
        checkoutDeleteSignal
      }
      removalResult = preserveBranchHeadFallback(
        await withWorktreeRemoveStageSpan('git_remove', 'local', async () =>
          removeWorktree(repo.path, canonicalWorktreePath, args.force ?? false, removeOptions)
        ),
        refreshedRegisteredWorktree.head
      )
    } catch (error) {
      if (usesNativeWindowsRemoval(canonicalWorktreePath, localWorktreeGitOptions)) {
        throw error
      }
      // Git deregisters even when its recursive filesystem deletion fails partway.
      const recoveredRemovalResult = await recoverPartialLocalWorktreeRemoval({
        error,
        force: args.force ?? false,
        canonicalWorktreePath,
        repoPath: repo.path,
        localWorktreeGitOptions,
        registeredWorktree: refreshedRegisteredWorktree,
        deleteBranch,
        closeWatcher: (worktreePath) => runtime.closeFileWatchersForRemoval(worktreePath),
        signal: checkoutDeleteSignal
      })
      if (recoveredRemovalResult) {
        removalResult = recoveredRemovalResult
        removalCompleted = true
      } else if (isOrphanedWorktreeError(error)) {
        console.warn(
          `[worktrees] Orphaned worktree detected at ${canonicalWorktreePath}, cleaning up`
        )
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalWorktreePath,
          localWorktreeGitOptions,
          (path) => runtime.closeFileWatchersForRemoval(path)
        )
        // Failed removal may retain registration and branch locks; prune stale tracking.
        await pruneGitWorktrees({ cwd: repo.path, ...localWorktreeGitOptions }).catch(() => {})
        await cleanupPushTarget()
        runtime.clearOptimisticReconcileToken(args.worktreeId)
        removeWorktreeMetadataAndTransientState(
          { store, runtime },
          args.worktreeId,
          removalHostId,
          args.snapshotPruneBatchId
        )
        preservedBranchCleanupByScope.delete(
          preservedBranchCleanupScopeKey({
            worktreeId: args.worktreeId,
            hostId: removalHostId
          })
        )
        invalidateAuthorizedRootsCacheForRepo(store, repoId)
        removalCompleted = true
        return {}
      } else {
        throw new Error(
          formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
        )
      }
    }
    // Successful unlisting overtakes any scan begun before removal.
    runWorktreeChangeInvalidators(repoId)
    removalCompleted = true
  } finally {
    await removalGate.finish(removalCompleted)
  }
  await cleanupPushTarget()
  rememberPreservedBranchCleanupTarget(
    args.worktreeId,
    removalHostId,
    removalResult,
    refreshedRegisteredWorktree.head,
    removedPushTarget
  )
  runtime.clearOptimisticReconcileToken(args.worktreeId)
  await withWorktreeRemoveStageSpan('metadata_purge', 'local', async () => {
    removeWorktreeMetadataAndTransientState(
      { store, runtime },
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
  })
  await withWorktreeRemoveStageSpan('cache_invalidation', 'local', async () => {
    invalidateAuthorizedRootsCacheForRepo(store, repoId)
  })
  return removalResult ?? {}
}
