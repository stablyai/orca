import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from './local-worktree-filesystem'
import {
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
    await removeLocalWorktreePath(path, options).catch(() => {})
  } else {
    console.warn(`[worktrees] Refusing recursive cleanup for unproven worktree directory: ${path}`)
  }
  if (!(await isWorktreePathMissing(runtimePath, access.statPath))) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
}
