import { win32, posix } from 'node:path'
import { areWorktreePathsEqual } from '../ipc/worktree-logic'
import {
  looksLikeWindowsPath,
  normalizeComparablePath,
  normalizeFsPath
} from '../usage/usage-path-comparison'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import type { GeminiUsageAttributedEvent, GeminiUsageParsedEvent } from './types'

export type GeminiUsageWorktreeRef = UsageScanWorktreeRef

function getDefaultProjectLabel(cwd: string | null): string {
  if (!cwd) {
    return 'Unknown location'
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts.at(-1) ?? cwd
}

function localDayFromTimestamp(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isContainingPath(candidatePath: string, targetPath: string): boolean {
  const useWin32 = looksLikeWindowsPath(candidatePath) || looksLikeWindowsPath(targetPath)
  const relativePath = useWin32
    ? win32.relative(candidatePath, targetPath)
    : posix.relative(candidatePath, targetPath)
  if (!relativePath) {
    return true
  }
  const isAbsoluteRelative = useWin32
    ? win32.isAbsolute(relativePath)
    : posix.isAbsolute(relativePath)
  const parentPrefix = useWin32 ? `..${win32.sep}` : `..${posix.sep}`
  return (
    !isAbsoluteRelative &&
    relativePath !== '..' &&
    !relativePath.startsWith(parentPrefix) &&
    relativePath !== '.'
  )
}

function findContainingWorktree(
  cwd: string,
  worktrees: (GeminiUsageWorktreeRef & { canonicalPath: string })[]
): GeminiUsageWorktreeRef | null {
  const normalizedCwd = normalizeComparablePath(cwd)
  let best: GeminiUsageWorktreeRef | null = null
  let bestLength = -1

  for (const worktree of worktrees) {
    if (
      areWorktreePathsEqual(worktree.path, cwd) ||
      areWorktreePathsEqual(worktree.canonicalPath, cwd)
    ) {
      return worktree
    }
    for (const candidate of [worktree.path, worktree.canonicalPath]) {
      const normalizedCandidate = normalizeComparablePath(candidate)
      if (
        isContainingPath(normalizedCandidate, normalizedCwd) &&
        normalizedCandidate.length > bestLength
      ) {
        best = worktree
        bestLength = normalizedCandidate.length
      }
    }
  }
  return best
}

export async function attributeGeminiUsageEvent(
  event: GeminiUsageParsedEvent,
  worktrees: (GeminiUsageWorktreeRef & { canonicalPath: string })[]
): Promise<GeminiUsageAttributedEvent | null> {
  const day = localDayFromTimestamp(event.timestamp)
  if (!day) {
    return null
  }

  const matchedWorktree = event.cwd ? findContainingWorktree(event.cwd, worktrees) : null
  const projectKey = matchedWorktree
    ? `worktree:${matchedWorktree.worktreeId}`
    : `path:${event.cwd ? normalizeFsPath(event.cwd) : 'unknown'}`
  const projectLabel = matchedWorktree?.displayName ?? getDefaultProjectLabel(event.cwd)

  return {
    ...event,
    day,
    projectKey,
    projectLabel,
    repoId: matchedWorktree?.repoId ?? null,
    worktreeId: matchedWorktree?.worktreeId ?? null
  }
}
