import { removeWorktree } from '../../../git/worktree-removal'
import { usesNativeWindowsRemoval } from '../../../git/windows-worktree-removal'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../../../worktree-removal-safety'
import { resolveWorktreeRemovalHomeForHost } from '../../../worktree-removal-execution-host-route'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../../../local-worktree-filesystem'
import {
  cleanupUnusedWorktreePushTargetRemote,
  notifyWorktreesChanged
} from '../../worktree-remote'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
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
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
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
        allowUnverifiedStop: args.allowUnverifiedPtyStop
      })
      await (usesNativeWindowsRemoval(worktreePath, localWorktreeGitOptions)
        ? removeWorktree(repo.path, worktreePath, args.force ?? false, {
            ...localWorktreeGitOptions,
            deleteBranch: false,
            knownRemovedWorktree: null
          })
        : removeLocalWorktreePath(worktreePath, localWorktreeGitOptions))
      removalCompleted = true
    } finally {
      await removalGate.finish(removalCompleted)
    }
    await cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      args.worktreeId,
      removedPushTarget,
      store,
      localWorktreeGitOptions
    )
    invalidateAuthorizedRootsCache()
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
    notifyWorktreesChanged(mainWindow, repoId)
    return {}
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
    notifyWorktreesChanged(mainWindow, repoId)
    return {}
  }
  throw new Error(`Refusing to delete unregistered worktree path: ${worktreePath}`)
}
