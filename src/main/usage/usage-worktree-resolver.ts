import { posix, win32 } from 'node:path'
import { areWorktreePathsEqual } from '../ipc/worktree-logic'
import { looksLikeWindowsPath, normalizeFsPath } from './usage-path-comparison'
import type { UsageScanWorktreeRef } from './usage-provider-contract'

export type CanonicalizedUsageWorktreeRef = UsageScanWorktreeRef & { canonicalPath: string }

/** Maps an event's `cwd` to the worktree that contains it, or null when it is outside every one. */
export type UsageWorktreeResolver = (cwd: string) => UsageScanWorktreeRef | null

function isContainingPath(candidatePath: string, targetPath: string): boolean {
  const useWin32 = looksLikeWindowsPath(candidatePath) || looksLikeWindowsPath(targetPath)
  const relativePath = useWin32
    ? win32.relative(candidatePath, targetPath)
    : posix.relative(candidatePath, targetPath)
  if (!relativePath) {
    return true
  }
  // Why: on Windows, `path.relative('C:\\repo', 'D:\\other')` returns an
  // absolute `D:\\other` path instead of a `..`-prefixed relative. Treating
  // that as "contained" would attribute off-drive usage to the wrong
  // Orca worktree.
  const isAbsoluteRelative = useWin32
    ? win32.isAbsolute(relativePath)
    : posix.isAbsolute(relativePath)
  const parentPrefix = useWin32 ? `..${win32.sep}` : `..${posix.sep}`
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  return (
    !isAbsoluteRelative &&
    relativePath !== '..' &&
    !relativePath.startsWith(parentPrefix) &&
    relativePath !== '.'
  )
}

function findContainingWorktree(
  cwd: string,
  worktrees: readonly CanonicalizedUsageWorktreeRef[]
): UsageScanWorktreeRef | null {
  const normalizedCwd = normalizeFsPath(cwd)
  for (const worktree of worktrees) {
    if (areWorktreePathsEqual(worktree.canonicalPath, normalizedCwd)) {
      return worktree
    }
    if (isContainingPath(worktree.canonicalPath, normalizedCwd)) {
      return worktree
    }
  }
  return null
}

/**
 * Resolver for one scan, memoized per `cwd`.
 *
 * Why: attribution runs per event but a corpus holds only a few hundred distinct cwds, so an
 * unmemoized search costs `events × worktrees` — 1.6M events against a few hundred remembered
 * worktrees is minutes of main-thread CPU (STA-7724).
 */
export function createUsageWorktreeResolver(
  worktrees: readonly CanonicalizedUsageWorktreeRef[]
): UsageWorktreeResolver {
  const worktreeByCwd = new Map<string, UsageScanWorktreeRef | null>()
  return (cwd) => {
    const memoized = worktreeByCwd.get(cwd)
    // Why: a cwd outside every worktree memoizes as null, so only `undefined` is a miss.
    if (memoized !== undefined) {
      return memoized
    }
    const resolved = findContainingWorktree(cwd, worktrees)
    worktreeByCwd.set(cwd, resolved)
    return resolved
  }
}
