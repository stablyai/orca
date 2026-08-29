import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import type { SshGitProvider } from '../../../providers/ssh-git-provider'
import { getSshFilesystemProvider } from '../../../providers/ssh-filesystem-dispatch'
import { deleteRemoteWorktreeHistory } from '../../../remote-worktree-history-cleanup'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaLeftoverDirectory,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../../../worktree-removal-safety'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../../../local-worktree-filesystem'
import {
  cleanupUnusedWorktreePushTargetRemote,
  cleanupUnusedWorktreePushTargetRemoteSsh,
  notifyWorktreesChanged
} from '../../worktree-remote'
import { getSshPtyProvider } from '../../pty'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { preservedBranchCleanupByScope } from './preserved-branch-cleanup'
import {
  removeWorktreeMetadataAndTransientState,
  stopPtysForDestructiveWorktreeRemoval
} from './worktree-removal-ownership'
import { isAlreadyRemovedWorktreePath, isLocalGitRepository } from './worktree-removal-filesystem'

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
  provider: SshGitProvider | null
): Promise<RemoveWorktreeResult> {
  const { mainWindow, store, runtime } = context
  const fsProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : null
  let canCleanOrphanedDirectory = false
  if (
    canCleanupUnregisteredOrcaWorktreeDirectory({
      meta: removedMeta
    })
  ) {
    if (repo.connectionId) {
      if (!fsProvider) {
        throw new Error('SSH filesystem provider unavailable')
      }
      if (!fsProvider.lstat) {
        throw new Error('SSH filesystem provider lstat unavailable')
      }
      canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
        worktreePath,
        repo.path,
        (path) => fsProvider.lstat!(path),
        (path) => fsProvider.readFile(path)
      )
    } else {
      const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
      canCleanOrphanedDirectory =
        !isDangerousWorktreeRemovalPath(worktreePath, repo.path) &&
        (await canSafelyRemoveOrphanedWorktreeDirectory(
          toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions),
          toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
          access.statPath,
          access.readPath
        ))
    }
  }
  if (canCleanOrphanedDirectory) {
    assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
    if (!args.force) {
      throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
    }
    if (repo.connectionId) {
      const removalGate = await runtime.acquireFileWatcherRemoval(worktreePath, repo.connectionId)
      let removalCompleted = false
      try {
        await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
          connectionId: repo.connectionId,
          allowUnverifiedStop: args.allowUnverifiedPtyStop
        })
        await fsProvider!.deletePath(worktreePath, true)
        removalCompleted = true
      } finally {
        await removalGate.finish(removalCompleted)
      }
      // Why history first: the worktree is already gone from git and
      // disk by here, so a rejecting push-target cleanup must not be
      // able to skip history removal and leave the user's commands on
      // the remote host.
      await deleteRemoteWorktreeHistory(getSshPtyProvider(repo.connectionId), args.worktreeId)
      await cleanupUnusedWorktreePushTargetRemoteSsh(
        provider!,
        repo.path,
        args.worktreeId,
        removedPushTarget,
        store
      )
    } else {
      const removalGate = await runtime.acquireFileWatcherRemoval(worktreePath)
      let removalCompleted = false
      try {
        await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
          allowUnverifiedStop: args.allowUnverifiedPtyStop
        })
        await removeLocalWorktreePath(worktreePath, localWorktreeGitOptions)
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
    }
    runtime.clearOptimisticReconcileToken(args.worktreeId)
    removeWorktreeMetadataAndTransientState(
      store,
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
  if (!repo.connectionId) {
    const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
    const runtimeWorktreePath = toLocalWorktreeRuntimePath(worktreePath, localWorktreeGitOptions)
    if (
      await canCleanupUnregisteredOrcaLeftoverDirectory({
        meta: removedMeta,
        worktreePath,
        runtimeWorktreePath,
        repo,
        runtimeRepoPath: toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
        registeredWorktrees,
        statPath: access.statPath,
        isGitRepository: (path) => isLocalGitRepository(path, localWorktreeGitOptions)
      })
    ) {
      if (!args.force) {
        throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
      }
      const removalGate = await runtime.acquireFileWatcherRemoval(worktreePath)
      let removalCompleted = false
      try {
        await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
          allowUnverifiedStop: args.allowUnverifiedPtyStop
        })
        await removeLocalWorktreePath(worktreePath, localWorktreeGitOptions)
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
      runtime.clearOptimisticReconcileToken(args.worktreeId)
      removeWorktreeMetadataAndTransientState(
        store,
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
      invalidateAuthorizedRootsCache()
      notifyWorktreesChanged(mainWindow, repoId)
      return {}
    }
  }
  if (await isAlreadyRemovedWorktreePath(repo, worktreePath, localWorktreeGitOptions)) {
    if (!args.force && !removedMeta) {
      // Why: without persisted metadata, require the renderer recovery path before deleting Orca-only state for an unregistered path.
      throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
    }
    // Why: a manually deleted worktree is already gone; persisted metadata proves it was an Orca-known row, so no force is needed.
    if (repo.connectionId) {
      // Why history first: the worktree is already gone from git and
      // disk by here, so a rejecting push-target cleanup must not be
      // able to skip history removal and leave the user's commands on
      // the remote host.
      await deleteRemoteWorktreeHistory(getSshPtyProvider(repo.connectionId), args.worktreeId)
      await cleanupUnusedWorktreePushTargetRemoteSsh(
        provider!,
        repo.path,
        args.worktreeId,
        removedPushTarget,
        store
      )
    } else {
      await cleanupUnusedWorktreePushTargetRemote(
        repo.path,
        args.worktreeId,
        removedPushTarget,
        store,
        localWorktreeGitOptions
      )
      invalidateAuthorizedRootsCache()
    }
    runtime.clearOptimisticReconcileToken(args.worktreeId)
    removeWorktreeMetadataAndTransientState(
      store,
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
