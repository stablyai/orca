import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import type { CapturedOwnerRemoval } from '../../../runtime/workspaces/removal/canonical-owner-removal'
import { captureWorktreeOwnerRemoval } from '../../../runtime/workspaces/removal/canonical-owner-removal-scopes'
import { usesNativeWindowsRemoval } from '../../../git/worktrees/removal/windows-worktree-removal'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { preservedBranchCleanupScopeKey } from '../../../../shared/git/branches/preserved-branch-cleanup'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../../../workspaces/removal/worktree-removal-safety'
import { resolveWorktreeRemovalHomeForHost } from '../../../workspaces/removal/worktree-removal-execution-host-route'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../../../workspaces/removal/local-worktree-filesystem'
import {
  cleanupUnusedWorktreePushTargetRemote,
  notifyWorktreesChanged
} from '../../worktree-remote'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { preservedBranchCleanupByScope } from './preserved-branch-cleanup'
import {
  removeWorktreeMetadataAndTransientState,
  stopPtysForDestructiveWorktreeRemoval
} from './worktree-removal-ownership'
import { isAlreadyRemovedWorktreePath } from './worktree-removal-filesystem'

export async function removeUnregisteredWorktree(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  worktreePath: string,
  removalHostId: ExecutionHostId,
  registeredWorktrees: GitWorktreeInfo[],
  removedMeta: WorktreeMeta | undefined,
  removedPushTarget: GitPushTarget | undefined,
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions,
  removeOwned: CapturedOwnerRemoval = captureWorktreeOwnerRemoval(
    context.store,
    args.worktreeId,
    removalHostId,
    () => context.runtime.openAgentSessionRecordStore()
  )
): Promise<RemoveWorktreeResult> {
  const { mainWindow, store, runtime } = context
  const removalHome = resolveWorktreeRemovalHomeForHost(removalHostId)
  let canCleanOrphanedDirectory = false
  if (
    canCleanupUnregisteredOrcaWorktreeDirectory({
      meta: removedMeta
    })
  ) {
    const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
    canCleanOrphanedDirectory =
      !isDangerousWorktreeRemovalPath(worktreePath, repo.path, removalHome) &&
      (await canSafelyRemoveOrphanedWorktreeDirectory(
        toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
        toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
        removalHome,
        access
      ))
  }
  const native = usesNativeWindowsRemoval(worktreePath, localWorktreeGitOptions)
  if (canCleanOrphanedDirectory || (native && removedMeta)) {
    assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
    if (canCleanOrphanedDirectory && !args.force) {
      throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
    }

    const removalGate = await runtime.acquireFileWatcherRemoval(worktreePath)
    let removalCompleted = false
    try {
      await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
        allowUnverifiedStop: args.allowUnverifiedPtyStop,
        deferSurfaceRetirement: true
      })
      await (usesNativeWindowsRemoval(worktreePath, localWorktreeGitOptions)
        ? removeWorktree(repo.path, worktreePath, args.force ?? false, {
            ...localWorktreeGitOptions,
            deleteBranch: false,
            knownRemovedWorktree: null
          })
        : removeLocalWorktreePath(worktreePath, localWorktreeGitOptions))
      removalCompleted = true
      await cleanupUnusedWorktreePushTargetRemote(
        repo.path,
        args.worktreeId,
        removedPushTarget,
        store,
        localWorktreeGitOptions
      )
      invalidateAuthorizedRootsCache()
      runtime.clearOptimisticReconcileToken(args.worktreeId)
      await removeOwned(() =>
        removeWorktreeMetadataAndTransientState(
          { store, runtime },
          args.worktreeId,
          removalHostId,
          args.snapshotPruneBatchId
        )
      )
      preservedBranchCleanupByScope.delete(
        preservedBranchCleanupScopeKey({
          worktreeId: args.worktreeId,
          hostId: removalHostId
        })
      )
      notifyWorktreesChanged(mainWindow, repoId)
      return {}
    } finally {
      await removalGate.finish(removalCompleted)
    }
  }
  if (await isAlreadyRemovedWorktreePath(worktreePath, localWorktreeGitOptions)) {
    if (!args.force && !removedMeta) {
      // Without persisted ownership, require renderer recovery approval before deleting unregistered state.
      throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
    }
    // Persisted metadata proves an already-missing path was Orca-owned; cleanup needs no force.
    await cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      args.worktreeId,
      removedPushTarget,
      store,
      localWorktreeGitOptions
    )
    invalidateAuthorizedRootsCache()
    runtime.clearOptimisticReconcileToken(args.worktreeId)
    await removeOwned(() =>
      removeWorktreeMetadataAndTransientState(
        { store, runtime },
        args.worktreeId,
        removalHostId,
        args.snapshotPruneBatchId
      )
    )
    preservedBranchCleanupByScope.delete(
      preservedBranchCleanupScopeKey({
        worktreeId: args.worktreeId,
        hostId: removalHostId
      })
    )
    notifyWorktreesChanged(mainWindow, repoId)
    return {}
  }
  throw new Error(`Refusing to delete unregistered worktree path: ${worktreePath}`)
}
