import { listWorktreesStrict } from './git/worktree'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from './local-worktree-filesystem'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isWorktreePathMissing,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE
} from './worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'

export async function cleanupLocalOrphanedWorktreeDirectory(
  repoPath: string,
  path: string,
  options: LocalWorktreeFilesystemOptions,
  closeWatchers: (path: string) => Promise<void>
): Promise<void> {
  const access = getLocalWorktreePathAccess(options)
  const runtimePath = toLocalWorktreeRuntimePath(path, options)
  if (
    await canSafelyRemoveOrphanedWorktreeDirectory(
      runtimePath,
      toLocalWorktreeRuntimePath(repoPath, options),
      CLIENT_REMOVAL_HOME,
      access.statPath,
      access.readPath
    )
  ) {
    await closeWatchers(path)
    const current = await listWorktreesStrict(repoPath, options)
    assertWorktreeDoesNotContainRegisteredWorktree(path, current)
    if (
      current.some((row) => areWorktreePathsEqual(row.path, path)) ||
      !(await isProvenLocalWorktreeRemovalLeftover(repoPath, path, options))
    ) {
      throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
    }
    await removeLocalWorktreePath(path, options).catch(() => {})
  } else {
    console.warn(`[worktrees] Refusing recursive cleanup for unproven worktree directory: ${path}`)
  }
  if (!(await isWorktreePathMissing(runtimePath, access.statPath))) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
}

export function isProvenLocalWorktreeRemovalLeftover(
  repoPath: string,
  path: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<boolean> {
  const access = getLocalWorktreePathAccess(options)
  return canSafelyRemoveOrphanedWorktreeDirectory(
    toLocalWorktreeRuntimePath(path, options),
    toLocalWorktreeRuntimePath(repoPath, options),
    CLIENT_REMOVAL_HOME,
    access.statPath,
    access.readPath
  )
}
