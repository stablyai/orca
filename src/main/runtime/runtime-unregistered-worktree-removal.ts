import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { IFilesystemProvider } from '../providers/types'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import {
  cleanupUnusedWorktreePushTargetRemote,
  cleanupUnusedWorktreePushTargetRemoteSsh
} from '../ipc/worktree-remote'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaLeftoverDirectory,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../worktree-removal-safety'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import {
  isLocalRuntimeGitRepository,
  isRuntimeWorktreePathMissing
} from './runtime-worktree-filesystem'

type RemovalGate = { finish: (removed: boolean) => Promise<void> }

export async function removeRuntimeUnregisteredWorktree(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktrees: readonly GitWorktreeInfo[]
  removedMeta: WorktreeMeta | undefined
  removedPushTarget: GitPushTarget | undefined
  force: boolean
  allowUnverifiedPtyStop: boolean
  provider: SshGitProvider | null
  fsProvider: IFilesystemProvider | null
  localOptions: LocalProjectWorktreeGitOptions
  store: RuntimeStore
  acquireWatcherRemoval: (path: string, connectionId?: string) => Promise<RemovalGate>
  stopPtys: (worktreeId: string, connectionId: string | undefined, allow: boolean) => Promise<void>
  deleteHistory: () => Promise<void>
  finishRemoval: () => void
}): Promise<{}> {
  const { repo, target, registeredWorktrees, removedMeta } = args
  let canCleanOrphanedDirectory = false
  if (canCleanupUnregisteredOrcaWorktreeDirectory({ meta: removedMeta })) {
    if (repo.connectionId) {
      if (!args.fsProvider) {
        throw new Error('SSH filesystem provider unavailable')
      }
      if (!args.fsProvider.lstat) {
        throw new Error('SSH filesystem provider lstat unavailable')
      }
      canCleanOrphanedDirectory = await canSafelyRemoveOrphanedWorktreeDirectory(
        target.path,
        repo.path,
        (path) => args.fsProvider!.lstat!(path),
        (path) => args.fsProvider!.readFile(path)
      )
    } else {
      const access = getLocalWorktreePathAccess(args.localOptions)
      canCleanOrphanedDirectory =
        !isDangerousWorktreeRemovalPath(target.path, repo.path) &&
        (await canSafelyRemoveOrphanedWorktreeDirectory(
          toLocalWorktreeRuntimePath(target.path, args.localOptions),
          toLocalWorktreeRuntimePath(repo.path, args.localOptions),
          access.statPath,
          access.readPath
        ))
    }
  }
  if (canCleanOrphanedDirectory) {
    assertWorktreeDoesNotContainRegisteredWorktree(target.path, registeredWorktrees)
    if (!args.force) {
      throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
    }
    await deleteUnregisteredDirectory(args)
    args.finishRemoval()
    return {}
  }
  if (!repo.connectionId) {
    const access = getLocalWorktreePathAccess(args.localOptions)
    const runtimeWorktreePath = toLocalWorktreeRuntimePath(target.path, args.localOptions)
    if (
      await canCleanupUnregisteredOrcaLeftoverDirectory({
        meta: removedMeta,
        worktreePath: target.path,
        runtimeWorktreePath,
        repo,
        runtimeRepoPath: toLocalWorktreeRuntimePath(repo.path, args.localOptions),
        registeredWorktrees,
        statPath: access.statPath,
        isGitRepository: (path) => isLocalRuntimeGitRepository(path, args.localOptions)
      })
    ) {
      if (!args.force) {
        throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
      }
      await deleteUnregisteredDirectory(args)
      args.finishRemoval()
      return {}
    }
  }
  if (await isRuntimeWorktreePathMissing(repo, target.path, args.localOptions)) {
    if (!args.force && !removedMeta) {
      throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
    }
    await cleanupPushTarget(args)
    await args.deleteHistory()
    args.finishRemoval()
    return {}
  }
  throw new Error(`Refusing to delete unregistered worktree path: ${target.path}`)
}

async function deleteUnregisteredDirectory(
  args: Parameters<typeof removeRuntimeUnregisteredWorktree>[0]
): Promise<void> {
  const connectionId = args.repo.connectionId?.trim() || undefined
  const gate = await args.acquireWatcherRemoval(args.target.path, connectionId)
  let completed = false
  try {
    await args.stopPtys(args.target.id, connectionId, args.allowUnverifiedPtyStop)
    await (connectionId
      ? args.fsProvider!.deletePath(args.target.path, true)
      : removeLocalWorktreePath(args.target.path, args.localOptions))
    completed = true
  } finally {
    await gate.finish(completed)
  }
  await cleanupPushTarget(args)
  await args.deleteHistory()
}

async function cleanupPushTarget(
  args: Parameters<typeof removeRuntimeUnregisteredWorktree>[0]
): Promise<void> {
  await (args.repo.connectionId
    ? cleanupUnusedWorktreePushTargetRemoteSsh(
        args.provider!,
        args.repo.path,
        args.target.id,
        args.removedPushTarget,
        args.store
      )
    : cleanupUnusedWorktreePushTargetRemote(
        args.repo.path,
        args.target.id,
        args.removedPushTarget,
        args.store,
        args.localOptions
      ))
}
