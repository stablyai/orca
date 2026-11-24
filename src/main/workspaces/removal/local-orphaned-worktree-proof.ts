import { isWindowsAbsolutePathLike } from '../../../shared/file-access/cross-platform-path'
import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePaths,
  type LocalWorktreeFilesystemOptions
} from './local-worktree-filesystem'
import type { WorktreeRemovalHomeAuthority } from './worktree-removal-home-guard'
import { canSafelyRemoveOrphanedWorktreeDirectory } from './worktree-removal-safety'

/** Ownership proof for a checkout Git no longer registers, in the spelling its `.git` file was written in. */
export async function provesLocalOrphanedWorktree(
  worktreePath: string,
  repoPath: string,
  options: LocalWorktreeFilesystemOptions,
  home: WorktreeRemovalHomeAuthority,
  runtimePaths?: readonly string[],
  signal?: AbortSignal
): Promise<boolean> {
  const [runtimePath, runtimeRepoPath] =
    runtimePaths ?? (await toLocalWorktreeRuntimePaths([worktreePath, repoPath], options, signal))
  const access = getLocalWorktreePathAccess(options, worktreePath)
  if (await canSafelyRemoveOrphanedWorktreeDirectory(runtimePath, runtimeRepoPath, home, access)) {
    return true
  }
  // Host Git writes gitdir: as C:/... for a drive repo, which the guest spelling can never match.
  return (
    process.platform === 'win32' &&
    runtimePath !== worktreePath &&
    isWindowsAbsolutePathLike(worktreePath) &&
    isWindowsAbsolutePathLike(repoPath) &&
    !isWslUncPath(repoPath) &&
    canSafelyRemoveOrphanedWorktreeDirectory(worktreePath, repoPath, home)
  )
}
