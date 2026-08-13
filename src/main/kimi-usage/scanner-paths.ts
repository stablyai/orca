import { existsSync } from 'node:fs'
import { realpath, readdir, stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import { resolveKimiSessionsDir } from '../ai-vault/session-scanner-kimi-paths'
import { areWorktreePathsEqual } from '../ipc/worktree-logic'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import type {
  KimiUsageAttributedEvent,
  KimiUsageParsedEvent,
  KimiUsageProcessedFile
} from './types'
import { localDayFromTimestamp } from './local-day'

export type KimiUsageWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

const YIELD_EVERY_DISCOVERY_ENTRIES = 100

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

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    const resolved = await realpath(pathValue)
    return normalizeFsPath(resolved)
  } catch {
    return normalizeFsPath(pathValue)
  }
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function walkStateJsonFiles(
  dirPath: string,
  progress: { entriesVisited: number } = { entriesVisited: 0 }
): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    progress.entriesVisited += 1
    if (progress.entriesVisited % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkStateJsonFiles(fullPath, progress)))
      continue
    }
    if (entry.isFile() && entry.name === 'state.json') {
      files.push(fullPath)
    }
  }
  return files
}

export function getKimiSessionsDirectories(): string[] {
  const sessionsDir = resolveKimiSessionsDir()
  return existsSync(sessionsDir) ? [sessionsDir] : []
}

export async function listKimiStateFiles(): Promise<string[]> {
  const files: string[] = []
  for (const dirPath of getKimiSessionsDirectories()) {
    try {
      files.push(...(await walkStateJsonFiles(dirPath)))
    } catch {
      // Missing or unreadable directory
    }
  }
  return files
}

export async function getProcessedFileInfo(
  filePath: string,
  wirePath: string | null = null
): Promise<KimiUsageProcessedFile> {
  const fileStat = await stat(filePath)
  const wireStat = wirePath ? await stat(wirePath).catch(() => null) : null
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    wirePath,
    wireMtimeMs: wireStat?.mtimeMs ?? null,
    wireSize: wireStat?.size ?? null
  }
}

export async function buildWorktreesWithCanonicalPaths(
  worktrees: KimiUsageWorktreeRef[]
): Promise<(KimiUsageWorktreeRef & { canonicalPath: string })[]> {
  return canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
}

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
