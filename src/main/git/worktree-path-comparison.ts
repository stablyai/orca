import { posix, win32 } from 'node:path'
import { foldWslUncPathCaseInsensitiveParts } from '../../shared/wsl-paths'
import type { GitWorktreeExecOptions } from './worktree-operation-options'
import { translateWslOutputPaths } from './runner'

/**
 * Normalize a worktree path for cross-platform comparison/keying: resolved, and case-folded on
 * Windows syntax.
 *
 * Why the path's own syntax outranks `platform`: whose filesystem a path names is a property of the
 * path, not of the desktop reading it, and folding a case-sensitive filesystem merges two real
 * checkouts into one row — enough for `removeWorktree` to pick the twin and delete its branch.
 *
 * Two syntaxes name a case-sensitive filesystem. A POSIX-absolute path is one. The other is the WSL
 * UNC alias, which is the shape that actually reaches removal: `listWorktreesStrict` runs every
 * listed path through `translateWorktreePath`, so git-in-the-distro's `/home/alice/Feature` arrives
 * as `\\wsl.localhost\Ubuntu\home\alice\Feature` and a plain `toLowerCase` folded the ext4 tail.
 * `foldWslUncPathCaseInsensitiveParts` already draws that line — Windows folds the share, the distro
 * and a drvfs `/mnt/<letter>` tail, and nothing else — and `git-fetch-head-lock` already relies on
 * it. `isSameCommonDirPath` and `ipc/worktree-path-comparison` carry local copies of the POSIX half;
 * this is both halves at the source.
 */
export function canonicalWorktreePath(pathValue: string, platform = process.platform): string {
  if (looksLikePosixAbsolutePath(pathValue)) {
    return posix.normalize(posix.resolve(pathValue))
  }
  const wslKey = wslUncComparisonKey(pathValue)
  if (wslKey) {
    return wslKey
  }
  return platform === 'win32' || looksLikeWindowsPath(pathValue)
    ? win32.normalize(win32.resolve(pathValue)).toLowerCase()
    : posix.normalize(posix.resolve(pathValue))
}

/**
 * The comparison key for a WSL UNC path, or null when it is not one.
 *
 * Normalized through `win32` first so `..`/`.` segments and slash style collapse, then folded only
 * where Windows really folds. The fold is unconditional on platform: a `\\wsl.localhost\...` string
 * names the same distro filesystem whichever desktop is reading it.
 */
function wslUncComparisonKey(pathValue: string): string | null {
  const folded = foldWslUncPathCaseInsensitiveParts(pathValue)
  if (!folded) {
    return null
  }
  return foldWslUncPathCaseInsensitiveParts(win32.normalize(pathValue)) ?? folded
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
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    return false
  }
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
