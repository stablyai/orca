import { realpath } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import { looksLikeWindowsPath, normalizeFsPath } from './usage-path-comparison'
import type { UsageScanWorktreeRef } from './usage-provider-contract'

type CanonicalizedUsageWorktreeRef = UsageScanWorktreeRef & { canonicalPath: string }

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
  // Windows cross-drive relative paths are absolute; reject them to avoid attributing usage to the wrong worktree.
  const isAbsoluteRelative = useWin32
    ? win32.isAbsolute(relativePath)
    : posix.isAbsolute(relativePath)
  const parentPrefix = useWin32 ? `..${win32.sep}` : `..${posix.sep}`
  // Only .. and ../ escape; ..name remains a valid child.
  return (
    !isAbsoluteRelative &&
    relativePath !== '..' &&
    !relativePath.startsWith(parentPrefix) &&
    relativePath !== '.'
  )
}

async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    return normalizeFsPath(await realpath(pathValue))
  } catch {
    return normalizeFsPath(pathValue)
  }
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

/** Memoize per cwd within one scan to avoid events × worktrees attribution cost (STA-7724). */
export async function createUsageWorktreeResolver(
  worktrees: readonly UsageScanWorktreeRef[]
): Promise<UsageWorktreeResolver> {
  const canonicalized = await canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
  const worktreeByCwd = new Map<string, UsageScanWorktreeRef | null>()
  return (cwd) => {
    const memoized = worktreeByCwd.get(cwd)
    // Outside-worktree null results are cached too; only undefined misses.
    if (memoized !== undefined) {
      return memoized
    }
    const resolved = findContainingWorktree(cwd, canonicalized)
    worktreeByCwd.set(cwd, resolved)
    return resolved
  }
}
