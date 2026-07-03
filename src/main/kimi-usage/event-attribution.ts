import { realpath } from 'fs/promises'
import { posix, win32 } from 'path'
import type { Repo } from '../../shared/types'
import { areWorktreePathsEqual } from '../ipc/worktree-logic'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import type { KimiUsageAttributedEvent, KimiUsageParsedEvent } from './types'

export type KimiUsageWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

function normalizeComparablePath(pathValue: string, platform = process.platform): string {
  const normalized = pathValue.replace(/\\/g, '/')
  return platform === 'win32' || looksLikeWindowsPath(pathValue)
    ? normalized.toLowerCase()
    : normalized
}

function normalizeFsPath(pathValue: string, platform = process.platform): string {
  if (platform === 'win32' || looksLikeWindowsPath(pathValue)) {
    return win32.normalize(win32.resolve(pathValue))
  }
  return posix.normalize(posix.resolve(pathValue))
}

export function getDefaultProjectLabel(cwd: string | null): string {
  if (!cwd) {
    return 'Unknown location'
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts.at(-1) ?? cwd
}

export function localDayFromTimestamp(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isContainingPath(candidatePath: string, targetPath: string): boolean {
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
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  return (
    !isAbsoluteRelative &&
    relativePath !== '..' &&
    !relativePath.startsWith(parentPrefix) &&
    relativePath !== '.'
  )
}

export async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    return normalizeFsPath(await realpath(pathValue))
  } catch {
    return normalizeFsPath(pathValue)
  }
}

export async function buildWorktreesWithCanonicalPaths(
  worktrees: KimiUsageWorktreeRef[]
): Promise<(KimiUsageWorktreeRef & { canonicalPath: string })[]> {
  return canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
}

export function findContainingWorktree(
  cwd: string,
  worktrees: (KimiUsageWorktreeRef & { canonicalPath: string })[]
): KimiUsageWorktreeRef | null {
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

export async function attributeKimiUsageEvent(
  event: KimiUsageParsedEvent,
  worktrees: (KimiUsageWorktreeRef & { canonicalPath: string })[]
): Promise<KimiUsageAttributedEvent | null> {
  const day = localDayFromTimestamp(event.timestamp)
  if (!day) {
    return null
  }

  let repoId: string | null = null
  let worktreeId: string | null = null
  let projectKey = 'unscoped'
  let projectLabel = getDefaultProjectLabel(event.cwd)

  if (event.cwd) {
    const worktree = findContainingWorktree(event.cwd, worktrees)
    if (worktree) {
      repoId = worktree.repoId
      worktreeId = worktree.worktreeId
      projectKey = `worktree:${worktree.worktreeId}`
      projectLabel = worktree.displayName
    } else {
      projectKey = `cwd:${normalizeComparablePath(event.cwd)}`
    }
  }

  return {
    ...event,
    day,
    projectKey,
    projectLabel,
    repoId,
    worktreeId
  }
}

export function createWorktreeRefs(
  repos: Repo[],
  worktreesByRepo: Map<string, { path: string; worktreeId: string; displayName: string }[]>
): KimiUsageWorktreeRef[] {
  const refs: KimiUsageWorktreeRef[] = []
  for (const repo of repos) {
    for (const worktree of worktreesByRepo.get(repo.id) ?? []) {
      refs.push({
        repoId: repo.id,
        worktreeId: worktree.worktreeId,
        path: worktree.path,
        displayName: worktree.displayName
      })
    }
  }
  return refs
}
