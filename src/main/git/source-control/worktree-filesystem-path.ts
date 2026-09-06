import { resolveGitMetadataPath } from '../../../shared/git-metadata-path'
import type { GitRuntimeOptions } from '../git-runtime-options'

const GUEST_ROOTED_PATH = /^\/(?!\/)/

/**
 * Whether a worktree path is a guest spelling the resolver can safely re-spell.
 *
 * Single leading slash only: `//wsl.localhost/...` and `//wsl$/...` are UNC spellings that also
 * start with `/`, and translating one prepends the distro root a second time. Trim-stable only:
 * the resolver returns `rawPath.trim()`, which would silently point a worktree whose name has
 * edge whitespace (legal on ext4) at a different directory.
 */
function isRespellableGuestPath(worktreePath: string): boolean {
  return GUEST_ROOTED_PATH.test(worktreePath) && worktreePath === worktreePath.trim()
}

/**
 * The worktree path as this process must spell it to open files inside it.
 *
 * Why: git executing in a WSL distro takes and reports guest paths, but Node reads them back
 * through Win32, where `/home/me/repo` is drive-relative and `/mnt/c/repo` means `C:\mnt\c\repo`.
 * Only reads that bypass git — direct lstat/open on working-tree files — need this; anything
 * handed to the git runner keeps the execution host's spelling.
 */
export function resolveWorktreeFilesystemPath(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): string {
  // The resolver is already an identity off win32; short-circuiting makes that structural.
  if (process.platform !== 'win32' || !isRespellableGuestPath(worktreePath)) {
    return worktreePath
  }
  // Unreachable: the resolver returns null only for an empty pointer, which the guard rejects.
  // Kept so the never-null contract stays the resolver's to state, not ours to assert.
  return resolveGitMetadataPath('', worktreePath, options) ?? worktreePath
}
