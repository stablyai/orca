import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

export function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  if (looksLikePosixAbsolutePath(leftPath) || looksLikePosixAbsolutePath(rightPath)) {
    // Why: local WSL projects run POSIX paths on a Windows desktop; comparing
    // them with win32 rules can delete or dedupe the wrong runtime-owned path.
    if (!looksLikePosixAbsolutePath(leftPath) || !looksLikePosixAbsolutePath(rightPath)) {
      return false
    }
    const left = normalizePosixWorktreePathForComparison(leftPath, platform)
    const right = normalizePosixWorktreePathForComparison(rightPath, platform)
    return left === right
  }

  if (
    platform === 'win32' ||
    isWindowsAbsolutePathLike(leftPath) ||
    isWindowsAbsolutePathLike(rightPath)
  ) {
    const left = normalizeWindowsWorktreePathForComparison(leftPath)
    const right = normalizeWindowsWorktreePathForComparison(rightPath)
    // Why: Git can report the same Windows path with different slash styles or
    // drive-letter casing; treating them as distinct creates duplicate worktrees.
    return left === right
  }
  const left = normalizePosixWorktreePathForComparison(leftPath, platform)
  const right = normalizePosixWorktreePathForComparison(rightPath, platform)
  return left === right
}

export function worktreePathComparisonKey(pathValue: string, platform = process.platform): string {
  if (looksLikePosixAbsolutePath(pathValue)) {
    return `posix:${normalizePosixWorktreePathForComparison(pathValue, platform)}`
  }
  if (platform === 'win32' || isWindowsAbsolutePathLike(pathValue)) {
    return `windows:${normalizeWindowsWorktreePathForComparison(pathValue)}`
  }
  return `posix:${normalizePosixWorktreePathForComparison(pathValue, platform)}`
}

export function dedupeWorktreesByPath<T extends { path: string }>(
  worktrees: readonly T[],
  platform = process.platform
): T[] {
  // Why: large Git/relay listings should normalize each path once while still
  // preserving the first row under the cross-platform equality contract above.
  const unique: T[] = []
  const posixAbsoluteKeys = new Set<string>()
  const windowsKeys = new Set<string>()
  const windowsPaths: string[] = []
  const relativePaths: string[] = []

  for (const worktree of worktrees) {
    const pathValue = worktree.path
    if (looksLikePosixAbsolutePath(pathValue)) {
      const key = normalizePosixWorktreePathForComparison(pathValue, platform)
      if (posixAbsoluteKeys.has(key)) {
        continue
      }
      posixAbsoluteKeys.add(key)
      unique.push(worktree)
      continue
    }

    const windowsKey = normalizeWindowsWorktreePathForComparison(pathValue)
    if (platform === 'win32' || isWindowsAbsolutePathLike(pathValue)) {
      if (
        windowsKeys.has(windowsKey) ||
        relativePaths.some((existing) => areWorktreePathsEqual(existing, pathValue, platform))
      ) {
        continue
      }
      windowsKeys.add(windowsKey)
      windowsPaths.push(pathValue)
      unique.push(worktree)
      continue
    }

    // Why: Git normally reports absolute paths. Retain pair-aware comparison
    // only for malformed/legacy relative rows whose flavor depends on its peer.
    if (
      relativePaths.some((existing) => areWorktreePathsEqual(existing, pathValue, platform)) ||
      windowsPaths.some((existing) => areWorktreePathsEqual(existing, pathValue, platform))
    ) {
      continue
    }
    relativePaths.push(pathValue)
    unique.push(worktree)
  }
  return unique
}

function looksLikePosixAbsolutePath(pathValue: string): boolean {
  return pathValue.startsWith('/') && !pathValue.startsWith('//')
}

export type FindListedWorktreeByPathOptions = {
  platform?: NodeJS.Platform
  /**
   * When true (default), fall back to filesystem realpath if string comparison
   * fails. Disable for WSL/SSH listings where host realpath is not authoritative.
   */
  resolveSymlinks?: boolean
  resolveRealPath?: (pathValue: string) => Promise<string>
}

/**
 * Find a worktree row for a path we just created. String equality is preferred;
 * local symlink roots (e.g. /home → /var/home on immutable Linux) need realpath.
 */
export async function findListedWorktreeByPath<T extends { path: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  options: FindListedWorktreeByPathOptions = {}
): Promise<T | undefined> {
  const platform = options.platform ?? process.platform
  const direct = worktrees.find((worktree) =>
    areWorktreePathsEqual(worktree.path, requestedPath, platform)
  )
  if (direct) {
    return direct
  }
  if (options.resolveSymlinks === false) {
    return undefined
  }

  const resolveRealPath = options.resolveRealPath ?? ((pathValue: string) => realpath(pathValue))
  let requestedReal: string
  try {
    requestedReal = await resolveRealPath(requestedPath)
  } catch {
    return undefined
  }

  for (const worktree of worktrees) {
    try {
      const listedReal = await resolveRealPath(worktree.path)
      if (areWorktreePathsEqual(listedReal, requestedReal, platform)) {
        return worktree
      }
    } catch {
      // Why: a missing/stale listing path should not abort the search of other rows.
    }
  }
  return undefined
}

function normalizeWindowsWorktreePathForComparison(pathValue: string): string {
  return win32.normalize(win32.resolve(pathValue)).toLowerCase()
}

function normalizePosixWorktreePathForComparison(
  pathValue: string,
  platform: NodeJS.Platform
): string {
  const normalized = posix.normalize(posix.resolve(pathValue))
  if (platform !== 'darwin') {
    return normalized
  }
  if (normalized === '/private/tmp') {
    return '/tmp'
  }
  return normalized.startsWith('/private/tmp/') ? normalized.slice('/private'.length) : normalized
}
