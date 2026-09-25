import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { yieldToEventLoop } from '../../shared/event-loop-yield'

export const TERMINAL_HISTORY_PENDING_DELETE_DIR_NAME = '.pending-delete'
const MAX_HISTORY_META_BYTES = 32 * 1024
import {
  DEFAULT_CODEX_SESSION_MAX_BYTES,
  DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS,
  MS_PER_DAY
} from './codex-session-retention'

export const DEFAULT_TERMINAL_HISTORY_MAX_AGE_MS = DEFAULT_PRIVATE_HISTORY_MAX_AGE_DAYS * MS_PER_DAY
export const DEFAULT_TERMINAL_HISTORY_MAX_BYTES = DEFAULT_CODEX_SESSION_MAX_BYTES
// Why: a worktree created after the live-id snapshot can own a directory younger than this.
const TERMINAL_HISTORY_MIN_ORPHAN_AGE_MS = 5 * 60 * 1000
const WALK_YIELD_EVERY = 64

export type TerminalHistoryDirectory = {
  path: string
  bytes: number
  worktreeId: string | null
  ageMs: number | null
}

export type TerminalHistoryRootSnapshot = {
  historyRoot: string
  totalBytes: number
  directories: number
  entries: TerminalHistoryDirectory[]
}

export type TerminalHistoryRetentionResult = {
  historyRoot: string
  scannedBytes: number
  removedDirectories: number
  removedBytes: number
  keptDirectories: number
  skippedReason: 'empty-live-set' | null
}

export function listTerminalHistoryRoots(userDataPath: string): string[] {
  const roots: string[] = []
  const main = join(userDataPath, 'terminal-history')
  if (isRealDirectory(main)) {
    roots.push(main)
  }
  const wslRoot = join(userDataPath, 'terminal-history-wsl')
  if (!isRealDirectory(wslRoot)) {
    return roots
  }
  for (const entry of readdirSync(wslRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue
    }
    const distroRoot = join(wslRoot, entry.name)
    if (isRealDirectory(distroRoot)) {
      roots.push(distroRoot)
    }
  }
  return roots
}

async function removeHistoryDirectoryNow(dir: string): Promise<boolean> {
  try {
    await rm(dir, { recursive: true, force: true })
    return true
  } catch (error) {
    console.warn(
      `[session-retention] Failed to remove terminal history: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

function readHistoryDirMeta(dir: string): { worktreeId?: string; createdAt?: string } | null {
  try {
    const metaPath = join(dir, 'meta.json')
    const info = lstatSync(metaPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_HISTORY_META_BYTES) {
      return null
    }
    const raw: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (!isRecord(raw)) {
      return null
    }
    return {
      ...(typeof raw.worktreeId === 'string' ? { worktreeId: raw.worktreeId } : {}),
      ...(typeof raw.createdAt === 'string' ? { createdAt: raw.createdAt } : {})
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRealDirectory(path: string): boolean {
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

export async function snapshotTerminalHistoryRoot(
  historyRoot: string,
  now: number
): Promise<TerminalHistoryRootSnapshot> {
  const entries: TerminalHistoryDirectory[] = []
  let totalBytes = 0
  let names: string[]
  try {
    names = await readdir(historyRoot)
  } catch {
    return { historyRoot, totalBytes: 0, directories: 0, entries }
  }
  let visited = 0
  for (const name of names) {
    visited += 1
    if (visited % WALK_YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
    if (name === TERMINAL_HISTORY_PENDING_DELETE_DIR_NAME) {
      continue
    }
    const dir = join(historyRoot, name)
    let info
    try {
      info = await lstat(dir)
    } catch {
      continue
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      continue
    }
    const bytes = await directoryBytes(dir)
    totalBytes += bytes
    const meta = readHistoryDirMeta(dir)
    const createdAt = meta?.createdAt ? Date.parse(meta.createdAt) : Number.NaN
    const ageMs = Number.isFinite(createdAt) ? now - createdAt : now - info.mtimeMs
    entries.push({
      path: dir,
      bytes,
      worktreeId: meta?.worktreeId ?? null,
      ageMs: Number.isFinite(ageMs) ? ageMs : null
    })
  }
  return { historyRoot, totalBytes, directories: entries.length, entries }
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const child = join(dir, name)
    let info
    try {
      info = await lstat(child)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) {
      continue
    }
    if (info.isDirectory()) {
      total += await directoryBytes(child)
      continue
    }
    if (info.isFile()) {
      total += info.size
    }
  }
  return total
}

export function selectTerminalHistoryDirectoriesToRemove(args: {
  entries: readonly TerminalHistoryDirectory[]
  liveWorktreeIds: ReadonlySet<string>
  maxAgeMs: number
  maxBytes: number
  totalBytes: number
}): TerminalHistoryDirectory[] {
  if (args.liveWorktreeIds.size === 0) {
    return []
  }
  const orphans = args.entries.filter(
    (entry) => entry.worktreeId !== null && !args.liveWorktreeIds.has(entry.worktreeId)
  )
  const remove = new Set<TerminalHistoryDirectory>()
  for (const entry of orphans) {
    if (entry.ageMs !== null && entry.ageMs >= args.maxAgeMs) {
      remove.add(entry)
    }
  }
  let remainingBytes = args.totalBytes
  for (const entry of remove) {
    remainingBytes -= entry.bytes
  }
  const sizeCandidates = orphans
    .filter((entry) => !remove.has(entry))
    .filter((entry) => entry.ageMs !== null && entry.ageMs >= TERMINAL_HISTORY_MIN_ORPHAN_AGE_MS)
    .sort((left, right) => (right.ageMs ?? 0) - (left.ageMs ?? 0))
  for (const entry of sizeCandidates) {
    if (remainingBytes <= args.maxBytes) {
      break
    }
    remove.add(entry)
    remainingBytes -= entry.bytes
  }
  return [...remove]
}

export async function applyTerminalHistoryRetention(args: {
  historyRoot: string
  liveWorktreeIds: ReadonlySet<string>
  now?: number
  maxAgeMs?: number
  maxBytes?: number
  dryRun?: boolean
  removeDirectory?: (dir: string, historyRoot: string) => boolean | Promise<boolean>
}): Promise<TerminalHistoryRetentionResult> {
  const now = args.now ?? Date.now()
  const snapshot = await snapshotTerminalHistoryRoot(args.historyRoot, now)
  if (args.liveWorktreeIds.size === 0) {
    return {
      historyRoot: args.historyRoot,
      scannedBytes: snapshot.totalBytes,
      removedDirectories: 0,
      removedBytes: 0,
      keptDirectories: snapshot.directories,
      skippedReason: 'empty-live-set'
    }
  }
  const victims = selectTerminalHistoryDirectoriesToRemove({
    entries: snapshot.entries,
    liveWorktreeIds: args.liveWorktreeIds,
    maxAgeMs: args.maxAgeMs ?? DEFAULT_TERMINAL_HISTORY_MAX_AGE_MS,
    maxBytes: args.maxBytes ?? DEFAULT_TERMINAL_HISTORY_MAX_BYTES,
    totalBytes: snapshot.totalBytes
  })
  const removeDirectory = args.removeDirectory ?? removeHistoryDirectoryNow
  let removedDirectories = 0
  let removedBytes = 0
  if (!args.dryRun) {
    for (const entry of victims) {
      const removed = await removeDirectory(entry.path, args.historyRoot)
      if (removed) {
        removedDirectories += 1
        removedBytes += entry.bytes
      }
    }
  } else {
    removedDirectories = victims.length
    removedBytes = victims.reduce((sum, entry) => sum + entry.bytes, 0)
  }
  return {
    historyRoot: args.historyRoot,
    scannedBytes: snapshot.totalBytes,
    removedDirectories,
    removedBytes,
    keptDirectories: snapshot.directories - removedDirectories,
    skippedReason: null
  }
}
