import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePaths
} from './local-worktree-filesystem'
import {
  canSafelyRemoveOrphanedWorktreeDirectory,
  isWorktreePathMissing,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE
} from './worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'

export async function cleanupLocalOrphanedWorktreeDirectory(
  repoPath: string,
  path: string,
  options: LocalWorktreeFilesystemOptions,
  closeWatchers: (path: string) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  throwIfSignalAborted(signal)
  const access = getLocalWorktreePathAccess(options)
  const [runtimePath, runtimeRepoPath] = await toLocalWorktreeRuntimePaths(
    [path, repoPath],
    options,
    signal
  )
  const safe = await canSafelyRemoveOrphanedWorktreeDirectory(
    runtimePath,
    runtimeRepoPath,
    CLIENT_REMOVAL_HOME,
    access
  )
  throwIfSignalAborted(signal)
  if (safe) {
    await closeWatchers(path)
    throwIfSignalAborted(signal)
    await removeLocalWorktreePath(path, options, signal).catch(() => {
      throwIfSignalAborted(signal)
    })
  } else {
    console.warn(`[worktrees] Refusing recursive cleanup for unproven worktree directory: ${path}`)
  }
  if (!(await isWorktreePathMissing(runtimePath, access.statPath))) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
}
