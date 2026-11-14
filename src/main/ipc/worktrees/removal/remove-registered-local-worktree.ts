import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import { assertRegisteredLocalWorktreePreflight } from './registered-local-worktree-preflight'
import type { Repo } from '../../../../shared/repo-types'
import {
  nativeWindowsMarkerMissing,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import { pruneGitWorktrees } from '../../../git/worktrees/removal/worktree-prune-guard'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { listWorktreesStrict as listGitWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import { getWorktreeSharedLinkPaths } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../workspaces/removal/local-orphaned-worktree-cleanup'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { assertNestedWorktreeRemovalApproval } from '../../../workspaces/removal/nested-worktree-removal-plan'
import { findRegisteredDeletableWorktree } from '../../../workspaces/removal/worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../../../workspaces/removal/worktree-removal-home-guard'
import { cleanupUnusedWorktreePushTargetRemote } from '../../worktree-remote'
import { findExistingWorktreeSymlinkPaths } from '../../../git/worktrees/content-paths/worktree-symlink-detection'
import { removeWorktreeLinkedPaths } from '../../worktree-symlinks'
import { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'
import { runWorktreeChangeInvalidators } from '../listing/worktree-change-invalidators'
import { formatWorktreeRemovalError, isOrphanedWorktreeError } from '../../worktree-logic'
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
import { preservedBranchCleanupScopeKey } from '../../../../shared/git/branches/preserved-branch-cleanup'
import * as backgroundRemoval from '../../../workspaces/removal/worktree-background-removal'
import { worktreeHostIdentity } from '../../../persistence/worktree-meta-host-identity'

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
  const markerMissing = await nativeWindowsMarkerMissing(
    canonicalWorktreePath,
    localWorktreeGitOptions
  )
  await assertRegisteredLocalWorktreePreflight(
    repo.path,
    canonicalWorktreePath,
    refreshedRegisteredWorktree,
    args.force ?? false,
    localWorktreeGitOptions,
    hasLocalWorktreeGitOptions,
    ignoredLinkedPaths,
    markerMissing
  )

  const background = backgroundRemoval.removesInBackground(
    canonicalWorktreePath,
    localWorktreeGitOptions
  )
  const prepare = async (): Promise<RemoveWorktreeResult> => {
    const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'local', async () =>
      context.runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
    )
    let accepted = false
    try {
      // Fence watcher/spawn installs through linked-path cleanup, Git removal and recursive fallback; PTYs must release handles first.
      await withWorktreeRemoveStageSpan('pty_sweep', 'local', async () => {
        await stopPtysForDestructiveWorktreeRemoval(context.runtime, args.worktreeId, {
          allowUnverifiedStop: args.allowUnverifiedPtyStop
        })
      })

      if (!markerMissing && linkedPaths.length > 0) {
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
    // Read before the purge drops the row; listeners hear `removed` after it.
    const removedIdentity = worktreeHostIdentity(context.store, args.worktreeId, removalHostId)
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
        deleteBranch,
        refreshedRegisteredWorktree,
        removalGate,
        checkoutDeleteSignal,
        cleanupPushTarget
      })
    if (!background) {
      const result = await finish()
      context.runtime.publishWorktreeRemovalChange(repoId)
      return result
    }
    // After acceptance, deletion must survive request cancellation; other views observe the host's removing marker.
    void backgroundRemoval.startBackgroundWorktreeRemoval({
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
          path: canonicalWorktreePath,
          ...removedIdentity
        })
        return result
      },
      publish: () => context.runtime.publishWorktreeRemovalChange(repoId),
      admissionFailed: () => removalGate.finish(false),
      cleanupPushTargetRemote: cleanupPushTarget
    })
    await backgroundRemoval.waitForWorktreeRemovalAcceptance(args.worktreeId)
    return { removing: true }
  }
  return background ? worktreeRemovalLifetime.withPreparation(prepare) : prepare()
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
  deleteBranch: boolean
  refreshedRegisteredWorktree: GitWorktreeInfo
  removalGate: { finish: (removed: boolean) => Promise<void> }
  checkoutDeleteSignal?: AbortSignal
  cleanupPushTarget: () => Promise<void>
}): Promise<RemoveWorktreeResult> {
  let removalResult: RemoveWorktreeResult | undefined
  let removalCompleted = false
  try {
    try {
      const removeOptions = {
        ...(!deleteBranch ? { deleteBranch } : {}),
        // Reuse the authoritative listing instead of rescanning siblings during deletion.
        knownRemovedWorktree: refreshedRegisteredWorktree,
        ...localWorktreeGitOptions,
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
        closeWatcher: (worktreePath) => context.runtime.closeFileWatchersForRemoval(worktreePath),
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
          (path) => context.runtime.closeFileWatchersForRemoval(path),
          checkoutDeleteSignal
        )
        // Failed removal may retain registration and branch locks; prune stale tracking.
        await pruneGitWorktrees({ cwd: repo.path, ...localWorktreeGitOptions }).catch(() => {})
        await cleanupPushTarget()
        context.runtime.clearOptimisticReconcileToken(args.worktreeId)
        removeWorktreeMetadataAndTransientState(
          context,
          args.worktreeId,
          removalHostId,
          args.snapshotPruneBatchId
        )
        const cleanupScopeKey = preservedBranchCleanupScopeKey({
          worktreeId: args.worktreeId,
          hostId: removalHostId
        })
        preservedBranchCleanupByScope.delete(cleanupScopeKey)
        invalidateAuthorizedRootsCacheForRepo(context.store, repoId)
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
  context.runtime.clearOptimisticReconcileToken(args.worktreeId)
  await withWorktreeRemoveStageSpan('metadata_purge', 'local', async () => {
    removeWorktreeMetadataAndTransientState(
      context,
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
  })
  await withWorktreeRemoveStageSpan('cache_invalidation', 'local', async () => {
    invalidateAuthorizedRootsCacheForRepo(context.store, repoId)
  })
  return removalResult ?? {}
}
