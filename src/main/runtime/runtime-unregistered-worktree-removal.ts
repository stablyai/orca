import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import {
  resolveWorktreeRemovalHome,
  type WorktreeRemovalRoute
} from '../worktree-removal-execution-host-route'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../local-worktree-filesystem'
import { cleanupUnusedWorktreePushTargetRemote } from '../ipc/worktree-remote'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canCleanupUnregisteredOrcaWorktreeDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE,
  UNREGISTERED_MISSING_WORKTREE_MESSAGE
} from '../worktree-removal-safety'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import { isLocalRuntimeWorktreePathMissing } from './runtime-worktree-filesystem'

type RemovalGate = { finish: (removed: boolean) => Promise<void> }

export async function removeRuntimeUnregisteredWorktree(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktrees: readonly GitWorktreeInfo[]
  removedMeta: WorktreeMeta | undefined
  removedPushTarget: GitPushTarget | undefined
  force: boolean
  allowUnverifiedPtyStop: boolean
  /** One resolved host for the whole removal. */
  route: WorktreeRemovalRoute
  localOptions: LocalProjectWorktreeGitOptions
  store: RuntimeStore
  acquireWatcherRemoval: (path: string) => Promise<RemovalGate>
  stopPtys: (worktreeId: string, allow: boolean) => Promise<void>
  finishRemoval: () => void
}): Promise<{}> {
  const { repo, target, registeredWorktrees, removedMeta, route } = args
  const removalHome = resolveWorktreeRemovalHome(route)
  let canCleanOrphanedDirectory = false
  if (canCleanupUnregisteredOrcaWorktreeDirectory({ meta: removedMeta })) {
    const access = getLocalWorktreePathAccess(args.localOptions)
    canCleanOrphanedDirectory =
      !isDangerousWorktreeRemovalPath(target.path, repo.path, removalHome) &&
      (await canSafelyRemoveOrphanedWorktreeDirectory(
        toLocalWorktreeRuntimePath(target.path, args.localOptions),
        toLocalWorktreeRuntimePath(repo.path, args.localOptions),
        removalHome,
        access.statPath,
        access.readPath
      ))
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
  if (await isLocalRuntimeWorktreePathMissing(target.path, args.localOptions)) {
    if (!args.force && !removedMeta) {
      throw new Error(UNREGISTERED_MISSING_WORKTREE_MESSAGE)
    }
    await cleanupPushTarget(args)
    args.finishRemoval()
    return {}
  }
  throw new Error(`Refusing to delete unregistered worktree path: ${target.path}`)
}

async function deleteUnregisteredDirectory(
  args: Parameters<typeof removeRuntimeUnregisteredWorktree>[0]
): Promise<void> {
  const gate = await args.acquireWatcherRemoval(args.target.path)
  let completed = false
  try {
    await args.stopPtys(args.target.id, args.allowUnverifiedPtyStop)
    await removeLocalWorktreePath(args.target.path, args.localOptions)
    completed = true
  } finally {
    await gate.finish(completed)
  }
  await cleanupPushTarget(args)
}

async function cleanupPushTarget(
  args: Parameters<typeof removeRuntimeUnregisteredWorktree>[0]
): Promise<void> {
  await cleanupUnusedWorktreePushTargetRemote(
    args.repo.path,
    args.target.id,
    args.removedPushTarget,
    args.store,
    args.localOptions
  )
}
