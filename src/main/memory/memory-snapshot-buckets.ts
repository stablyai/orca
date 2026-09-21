import { basename } from 'node:path'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { SessionMemory } from '../../shared/process-stats-types'
import type { MemorySnapshotStore } from './collector'

const APP_HISTORY_KEY = '__app__'
const HISTORY_CAPACITY = 60
const HISTORY_STALE_MS = 10 * 60 * 1000

type HistoryRing = {
  samples: number[]
  touchedAt: number
}

const historyByKey = new Map<string, HistoryRing>()

export function pushMemoryHistorySample(key: string, memoryBytes: number, now: number): void {
  let ring = historyByKey.get(key)
  if (!ring) {
    ring = { samples: [], touchedAt: now }
    historyByKey.set(key, ring)
  }
  ring.samples.push(memoryBytes)
  if (ring.samples.length > HISTORY_CAPACITY) {
    ring.samples.shift()
  }
  ring.touchedAt = now
}

export function readMemoryHistory(key: string): number[] {
  const ring = historyByKey.get(key)
  return ring ? [...ring.samples] : []
}

export function sweepStaleMemoryHistory(now: number): void {
  for (const [key, ring] of historyByKey) {
    if (now - ring.touchedAt > HISTORY_STALE_MS) {
      historyByKey.delete(key)
    }
  }
}

export function pushAppMemoryHistory(memoryBytes: number, now: number): void {
  pushMemoryHistorySample(APP_HISTORY_KEY, memoryBytes, now)
}

export function readAppMemoryHistory(): number[] {
  return readMemoryHistory(APP_HISTORY_KEY)
}

export type WorktreeMemoryBucket = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: number
  memory: number
  privateMemory: number
  sessions: SessionMemory[]
}

export function resolveWorktreeMemoryNames(
  worktreeId: string,
  store: MemorySnapshotStore
): {
  worktreeName: string
  repoId: string
  repoName: string
} {
  // Orca worktree ids look like `${repoId}::${absolutePath}`.
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repoId = parsed?.repoId ?? worktreeId
  const worktreePath = parsed?.worktreePath ?? ''
  const fallbackName = worktreePath ? basename(worktreePath) : worktreeId
  const meta = store.getWorktreeMeta(worktreeId)
  const repo = store.getRepo(repoId)

  return {
    worktreeName: meta?.displayName?.trim() || fallbackName,
    repoId,
    repoName: repo?.displayName?.trim() || repoId || 'Unknown Repo'
  }
}

export function createEmptyWorktreeMemoryBucket(
  worktreeId: string,
  worktreeName: string,
  repoId: string,
  repoName: string
): WorktreeMemoryBucket {
  return {
    worktreeId,
    worktreeName,
    repoId,
    repoName,
    cpu: 0,
    memory: 0,
    privateMemory: 0,
    sessions: []
  }
}
