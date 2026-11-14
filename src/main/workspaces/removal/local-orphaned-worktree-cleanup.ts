import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import { prepareLocalWorktreeFilesystem } from './local-worktree-filesystem'
import {
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath,
  isWorktreePathMissing,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE
} from './worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'

export async function cleanupLocalOrphanedWorktreeDirectory(
  repoPath: string,
  path: string,
  options: LocalWorktreeFilesystemOptions,
  closeWatchers: (path: string) => Promise<void>,
  signal: AbortSignal | undefined = options.signal
): Promise<void> {
  throwIfSignalAborted(signal)
  if (isDangerousWorktreeRemovalPath(path, repoPath, CLIENT_REMOVAL_HOME)) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
  const filesystem = await prepareLocalWorktreeFilesystem([path, repoPath], { ...options, signal })
  const { access } = filesystem
  const runtimePath = filesystem.runtimePath(path)
  const safe = await canSafelyRemoveOrphanedWorktreeDirectory(
    runtimePath,
    filesystem.runtimePath(repoPath),
    CLIENT_REMOVAL_HOME,
    access
  )
  filesystem.assertCurrent()
  let removed = false
  if (safe) {
    await closeWatchers(path)
    filesystem.assertCurrent()
    try {
      await filesystem.remove(path)
      removed = true
    } catch {
      filesystem.assertCurrent()
    }
  } else {
    console.warn(`[worktrees] Refusing recursive cleanup for unproven worktree directory: ${path}`)
  }
  const assertSettlement = removed ? filesystem.assertAuthorityCurrent : filesystem.assertCurrent
  assertSettlement()
  const missing = await isWorktreePathMissing(
    runtimePath,
    removed ? filesystem.statPathAfterRemoval : access.statPath
  )
  assertSettlement()
  if (!missing) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
}
