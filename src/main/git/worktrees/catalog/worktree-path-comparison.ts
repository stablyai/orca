import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../../../shared/file-access/cross-platform-path'
import { foldWslUncPathCaseInsensitiveParts } from '../../../../shared/file-access/wsl-paths'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { translateWslOutputPaths } from '../../command-runner/host-routing/wsl-path-translation'

/** Path syntax determines case folding: preserve POSIX and WSL ext4 tails even on Windows to avoid merging checkouts. */
export function canonicalWorktreePath(pathValue: string, platform = process.platform): string {
  if (looksLikePosixAbsolutePath(pathValue)) {
    return canonicalPosixPath(pathValue, platform)
  }
  const wslKey = wslUncComparisonKey(pathValue)
  if (wslKey) {
    return wslKey
  }
  return platform === 'win32' || looksLikeWindowsPath(pathValue)
    ? win32.normalize(win32.resolve(pathValue)).toLowerCase()
    : canonicalPosixPath(pathValue, platform)
}

// macOS Git reports /tmp checkouts as /private/tmp.
function canonicalPosixPath(pathValue: string, platform: NodeJS.Platform): string {
  const normalized = posix.normalize(posix.resolve(pathValue))
  if (platform !== 'darwin') {
    return normalized
  }
  if (normalized === '/private/tmp') {
    return '/tmp'
  }
  return normalized.startsWith('/private/tmp/') ? normalized.slice('/private'.length) : normalized
}

/** Normalize WSL UNC paths on every host, folding only the Windows-insensitive parts. */
function wslUncComparisonKey(pathValue: string): string | null {
  const folded = foldWslUncPathCaseInsensitiveParts(pathValue)
  if (!folded) {
    return null
  }
  return (foldWslUncPathCaseInsensitiveParts(win32.normalize(pathValue)) ?? folded).replace(
    /\/+$/,
    ''
  )
}

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  const leftIsPosix = looksLikePosixAbsolutePath(leftPath)
  if (leftIsPosix || looksLikePosixAbsolutePath(rightPath)) {
    // win32.resolve would attach a drive to POSIX paths and manufacture cross-filesystem equality.
    return (
      leftIsPosix &&
      looksLikePosixAbsolutePath(rightPath) &&
      canonicalWorktreePath(leftPath, platform) === canonicalWorktreePath(rightPath, platform)
    )
  }
  if (
    platform === 'win32' ||
    isWindowsAbsolutePathLike(leftPath) ||
    isWindowsAbsolutePathLike(rightPath)
  ) {
    return canonicalWorktreePath(leftPath, 'win32') === canonicalWorktreePath(rightPath, 'win32')
  }
  return canonicalWorktreePath(leftPath, platform) === canonicalWorktreePath(rightPath, platform)
}

export function dedupeWorktreesByPath<T extends { path: string }>(
  worktrees: readonly T[],
  platform = process.platform,
  merge: (kept: T, duplicate: T) => T = (kept) => kept
): T[] {
  // Key absolute paths once; only host-dependent relative paths require pairwise comparison.
  const unique: T[] = []
  const posixKeys = new Map<string, number>()
  const windowsKeys = new Map<string, number>()
  const windowsIndexes: number[] = []
  const relativeIndexes: number[] = []
  const findMatch = (indexes: number[], pathValue: string): number | undefined =>
    indexes.find((index) => areWorktreePathsEqual(unique[index].path, pathValue, platform))

  for (const worktree of worktrees) {
    const pathValue = worktree.path
    let match: number | undefined
    if (looksLikePosixAbsolutePath(pathValue)) {
      const key = canonicalWorktreePath(pathValue, platform)
      match = posixKeys.get(key)
      if (match === undefined) {
        posixKeys.set(key, unique.length)
      }
    } else if (platform === 'win32' || isWindowsAbsolutePathLike(pathValue)) {
      const key = canonicalWorktreePath(pathValue, 'win32')
      match = windowsKeys.get(key) ?? findMatch(relativeIndexes, pathValue)
      if (match === undefined) {
        windowsKeys.set(key, unique.length)
        windowsIndexes.push(unique.length)
      }
    } else {
      match = findMatch(relativeIndexes, pathValue) ?? findMatch(windowsIndexes, pathValue)
      if (match === undefined) {
        relativeIndexes.push(unique.length)
      }
    }
    if (match === undefined) {
      unique.push(worktree)
    } else {
      unique[match] = merge(unique[match], worktree)
    }
  }
  return unique
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

// One leading slash only: `//server/share` and WSL UNC aliases are Windows roots, not POSIX paths.
export function looksLikePosixAbsolutePath(pathValue: string): boolean {
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
