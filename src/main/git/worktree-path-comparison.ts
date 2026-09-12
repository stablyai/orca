import { posix, win32 } from 'node:path'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { translateWslOutputPaths } from './runner'

/**
 * Normalize a worktree path for cross-platform comparison/keying: resolved, and case-folded on
 * Windows syntax.
 *
 * Why a POSIX-absolute path outranks `platform`: whose filesystem a path names is a property of the
 * path, not of the desktop reading it. A WSL or SSH checkout is spelled `/home/...` on a Windows
 * desktop too, and folding its case there merged two case-variant checkouts into one row — enough
 * for `removeWorktree` to pick the twin and delete its branch. `isSameCommonDirPath` and
 * `ipc/worktree-path-comparison` each carry a local copy of this rule; this is the same rule at the
 * source.
 */
export function canonicalWorktreePath(pathValue: string, platform = process.platform): string {
  if (looksLikePosixAbsolutePath(pathValue)) {
    return posix.normalize(posix.resolve(pathValue))
  }
  return platform === 'win32' || looksLikeWindowsPath(pathValue)
    ? win32.normalize(win32.resolve(pathValue)).toLowerCase()
    : posix.normalize(posix.resolve(pathValue))
}

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  const leftIsPosix = looksLikePosixAbsolutePath(leftPath)
  if (leftIsPosix || looksLikePosixAbsolutePath(rightPath)) {
    // Why not fall through: `win32.resolve` gives a POSIX path a drive root, manufacturing an
    // equality with a Windows path that names a different filesystem.
    return (
      leftIsPosix &&
      looksLikePosixAbsolutePath(rightPath) &&
      canonicalWorktreePath(leftPath, platform) === canonicalWorktreePath(rightPath, platform)
    )
  }
  if (platform === 'win32' || looksLikeWindowsPath(leftPath) || looksLikeWindowsPath(rightPath)) {
    return canonicalWorktreePath(leftPath, 'win32') === canonicalWorktreePath(rightPath, 'win32')
  }
  return canonicalWorktreePath(leftPath, platform) === canonicalWorktreePath(rightPath, platform)
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

// One leading slash only: `//server/share` and WSL UNC aliases are Windows roots, not POSIX paths.
function looksLikePosixAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith('/') && !pathValue.startsWith('//')
}

export function resolveRevParsePath(repoPath: string, value: string): string {
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) {
    return value
  }
  // Old git ignores `--path-format=absolute`, so resolve a relative toplevel/git-dir against the scanned repo path.
  return looksLikeWindowsPath(repoPath)
    ? win32.resolve(repoPath, value)
    : posix.resolve(repoPath, value)
}

export function translateWorktreePath(
  worktreePath: string,
  repoPath: string,
  options: GitWorktreeExecOptions = {}
): string {
  const prefix = 'worktree '
  const translated = translateWslOutputPaths(`${prefix}${worktreePath}`, repoPath, options)
  return translated.startsWith(prefix) ? translated.slice(prefix.length) : worktreePath
}
