import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import type { AcceptedCheckoutGuard } from '../../../workspaces/removal/worktree-removal-gitdir-identity'
import { CheckoutIdentityRefusal } from '../../../workspaces/removal/worktree-removal-leftover'
import { prepareRegisteredLocalWorktreeRemoval } from './registered-local-worktree-preflight'
import { getWorktreeSharedLinkPaths } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import type { Repo } from '../../../../shared/repository/repo-types'
import { usesNativeWindowsRemoval } from '../../../git/worktrees/removal/windows-worktree-removal'
import { pruneGitWorktrees } from '../../../git/worktrees/removal/worktree-prune-guard'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../workspaces/removal/local-orphaned-worktree-cleanup'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { assertNestedWorktreeRemovalApproval } from '../../../workspaces/removal/nested-worktree-removal-plan'
import { cleanupUnusedWorktreePushTargetRemote } from '../worktree-remote'
import { removeWorktreeLinkedPaths } from '../linked-paths/worktree-symlinks'
import { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'
import { runWorktreeChangeInvalidators } from '../listing/worktree-change-invalidators'
import { formatWorktreeRemovalError, isOrphanedWorktreeError } from '../paths/worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  preserveBranchHeadFallback,
  preservedBranchCleanupByScope,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import {
  removeDeletedCheckoutMetadataAndTransientState,
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
  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const {
    refreshed: refreshedRegisteredWorktree,
    guard,
    markerMissing
  } = await prepareRegisteredLocalWorktreeRemoval({
    repo,
    canonicalWorktreePath,
    force: args.force ?? false,
    localOptions: localWorktreeGitOptions,
    hasLocalOptions: hasLocalWorktreeGitOptions,
    linkedPaths,
    beforeUnlockCheck: (refreshed) => {
      if (args.expectedCheckout) {
        assertNestedWorktreeRemovalApproval([refreshed], [args.expectedCheckout])
      }
    }
  })

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
        await guard.verify()
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
        cleanupPushTarget,
        guard
      })
    if (!background) {
      const result = await finish()
      context.runtime.publishWorktreeRemovalChange(repoId)
      return result
    }
    // After acceptance, deletion must survive request cancellation; other views observe the host's removing marker.
    const completion = backgroundRemoval.startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: args.worktreeId,
        repoId,
        repoPath: repo.path,
        worktree: refreshedRegisteredWorktree,
        gitdir: guard.gitdir,
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
      admissionFailed: () => removalGate.finish(false)
    })
    await backgroundRemoval.waitForWorktreeRemovalAcceptance(args.worktreeId)
    return backgroundRemoval.withAcceptedCompletion({ removing: true }, completion)
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
  cleanupPushTarget,
  guard
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
  guard: AcceptedCheckoutGuard
}): Promise<RemoveWorktreeResult> {
  const purgeRemoved = async (withStageSpans: boolean): Promise<void> => {
    await cleanupPushTarget()
    context.runtime.clearOptimisticReconcileToken(args.worktreeId)
    const purgeMetadata = () =>
      removeDeletedCheckoutMetadataAndTransientState(
        context,
        args.worktreeId,
        removalHostId,
        args.snapshotPruneBatchId
      )
    const invalidateRoots = () => invalidateAuthorizedRootsCacheForRepo(context.store, repoId)
    if (withStageSpans) {
      await withWorktreeRemoveStageSpan('metadata_purge', 'local', purgeMetadata)
      await withWorktreeRemoveStageSpan('cache_invalidation', 'local', async () =>
        invalidateRoots()
      )
    } else {
      await purgeMetadata()
      preservedBranchCleanupByScope.delete(
        preservedBranchCleanupScopeKey({ worktreeId: args.worktreeId, hostId: removalHostId })
      )
      invalidateRoots()
    }
  }
  let removalResult: RemoveWorktreeResult | undefined
  let removalCompleted = false
  try {
    try {
      const removeOptions = {
        ...(!deleteBranch ? { deleteBranch } : {}),
        // Reuse the authoritative listing instead of rescanning siblings during deletion.
        knownRemovedWorktree: refreshedRegisteredWorktree,
        ...localWorktreeGitOptions,
        ...guard.markerOptions,
        checkoutDeleteSignal,
        beforeCheckoutDelete: guard.verify
      }
      removalResult = preserveBranchHeadFallback(
        await withWorktreeRemoveStageSpan('git_remove', 'local', async () =>
          removeWorktree(repo.path, canonicalWorktreePath, args.force ?? false, removeOptions)
        ),
        refreshedRegisteredWorktree.head
      )
    } catch (error) {
      if (
        error instanceof CheckoutIdentityRefusal ||
        usesNativeWindowsRemoval(canonicalWorktreePath, localWorktreeGitOptions)
      ) {
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
        signal: checkoutDeleteSignal,
        ...guard.markerOptions
      })
      if (recoveredRemovalResult) {
        removalResult = recoveredRemovalResult
        removalCompleted = true
      } else if (isOrphanedWorktreeError(error)) {
        await guard.verify()
        console.warn(
          `[worktrees] Orphaned worktree detected at ${canonicalWorktreePath}, cleaning up`
        )
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalWorktreePath,
          localWorktreeGitOptions,
          (path) => context.runtime.closeFileWatchersForRemoval(path),
          checkoutDeleteSignal,
          guard.markerOptions
        )
        await pruneGitWorktrees({ cwd: repo.path, ...localWorktreeGitOptions }).catch(() => {})
        await purgeRemoved(false)
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
  rememberPreservedBranchCleanupTarget(
    args.worktreeId,
    removalHostId,
    removalResult,
    refreshedRegisteredWorktree.head,
    removedPushTarget
  )
  await purgeRemoved(true)
  return removalResult ?? {}
}
