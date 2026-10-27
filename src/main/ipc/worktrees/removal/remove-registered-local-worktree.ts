import type { Repo } from '../../../../shared/repo-types'
import { pruneGitWorktrees } from '../../../git/worktree-prune-guard'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import {
  assertWorktreeCleanForRemoval,
  listWorktreesStrict as listGitWorktreesStrict,
  removeWorktree
} from '../../../git/worktree'
import { getWorktreeSharedLinkPaths } from '../../../git/worktree-shared-directories'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../local-orphaned-worktree-cleanup'
import { recoverLocalWindowsWorktreeRemoval } from '../../../local-worktree-removal-recovery'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { assertNestedWorktreeRemovalApproval } from '../../../nested-worktree-removal-plan'
import { findRegisteredDeletableWorktree } from '../../../worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../../../worktree-removal-home-guard'
import { cleanupUnusedWorktreePushTargetRemote } from '../../worktree-remote'
import {
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths
} from '../../worktree-symlinks'
import { invalidateAuthorizedRootsCacheForRepo } from '../../registered-worktree-roots-scoped-invalidation'
import { runWorktreeChangeInvalidators } from '../../worktree-change-invalidators'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError
} from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  preserveBranchHeadFallback,
  preservedBranchCleanupByScope,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import {
  removeWorktreeMetadataAndTransientState,
  stopPtysForDestructiveWorktreeRemoval
} from './worktree-removal-ownership'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import {
  removesInBackground,
  startBackgroundWorktreeRemoval
} from '../../../worktree-background-removal'

export async function removeRegisteredLocalWorktree(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  canonicalWorktreePath: string,
  removalHostId: ExecutionHostId,
  removedPushTarget: GitPushTarget | undefined,
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions,
  hasLocalWorktreeGitOptions: boolean,
  deleteBranch: boolean
): Promise<RemoveWorktreeResult> {
  const { runtime } = context
  const refreshedWorktrees = hasLocalWorktreeGitOptions
    ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
    : await listGitWorktreesStrict(repo.path)
  const refreshedRegisteredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    canonicalWorktreePath,
    refreshedWorktrees,
    CLIENT_REMOVAL_HOME
  )
  if (!refreshedRegisteredWorktree) {
    throw new Error(
      `Worktree registration changed during deletion: ${canonicalWorktreePath}. Retry deletion.`
    )
  }
  if (args.expectedCheckout) {
    assertNestedWorktreeRemovalApproval([refreshedRegisteredWorktree], [args.expectedCheckout])
  }
  try {
    // Archive hooks can race external Git locks; recheck before destructive teardown.
    assertWorktreeUnlockedForRemoval(refreshedRegisteredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
  }

  // Repo shared-directory symlinks need the same ignore/unlink policy as user-configured shared paths.
  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const ignoredLinkedPaths = args.force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalWorktreePath, linkedPaths)
  try {
    await (hasLocalWorktreeGitOptions
      ? assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false, {
          ...localWorktreeGitOptions,
          ...(ignoredLinkedPaths.length > 0 ? { ignoredUntrackedPaths: ignoredLinkedPaths } : {})
        })
      : ignoredLinkedPaths.length > 0
        ? assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false, {
            ignoredUntrackedPaths: ignoredLinkedPaths
          })
        : assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false))
  } catch (error) {
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
    }
    // Git may discover orphaning after preflight; recursive fallback still requires strict PTY teardown.
  }

  const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'local', async () =>
    runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
  )
  let accepted = false
  try {
    // Fence watcher/spawn installs through linked-path cleanup, Git removal and recursive fallback; PTYs must release handles first.
    await withWorktreeRemoveStageSpan('pty_sweep', 'local', async () => {
      await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
        allowUnverifiedStop: args.allowUnverifiedPtyStop
      })
    })

    if (linkedPaths.length > 0) {
      await removeWorktreeLinkedPaths(canonicalWorktreePath, linkedPaths)
    }
    accepted = true
  } finally {
    if (!accepted) {
      await removalGate.finish(false)
    }
  }

  const cleanupPushTarget = () =>
    cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      args.worktreeId,
      removedPushTarget,
      context.store,
      localWorktreeGitOptions
    )
  const finish = (checkoutDeleteSignal?: AbortSignal): Promise<RemoveWorktreeResult> =>
    finishLocalWorktreeRemoval({
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
    })
  if (!removesInBackground(canonicalWorktreePath, localWorktreeGitOptions)) {
    const result = await finish()
    runtime.publishWorktreeRemovalChange(repoId)
    return result
  }
  // After acceptance, deletion must survive request cancellation; other views observe the host's removing marker.
  void startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: args.worktreeId,
      repoId,
      repoPath: repo.path,
      worktree: refreshedRegisteredWorktree,
      deleteBranch,
      force: args.force ?? false
    },
    run: async (stopSignal) => {
      const result = await finish(stopSignal)
      context.options?.onWorktreeLifecycle?.({
        kind: 'removed',
        worktreeId: args.worktreeId,
        path: canonicalWorktreePath
      })
      return result
    },
    publish: () => runtime.publishWorktreeRemovalChange(repoId),
    cleanupPushTargetRemote: cleanupPushTarget
  })
  return { removing: true }
}

async function finishLocalWorktreeRemoval({
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
      // Git for Windows may deregister before recursive filesystem deletion fails.
      const recoveredRemovalResult = await recoverLocalWindowsWorktreeRemoval({
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
