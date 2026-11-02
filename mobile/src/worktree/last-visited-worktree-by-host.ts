import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { PAGE_STORAGE_MAX_VALUE_CHARS } from '../mobile-web-shell/page-storage-keys'
import { persistMirrored, readMirroredKeyOrStore } from '../storage/mirrored-storage-keys'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  readLastVisitedWorktreeRecord,
  type LastVisitedWorktreeRecord
} from './last-visited-worktree-repo'
import { routeExecutionHostOf, type LastVisitedWorktreeOnHost } from './host-list-highlight'

// Bound history below the page-store frame cap; forgotten hosts never write again.
const MAX_REMEMBERED_HOSTS = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function visitOf(worktreeId: string, executionHost: string | undefined): LastVisitedWorktreeOnHost {
  const server = routeExecutionHostOf(executionHost)
  return server ? { worktreeId, executionHost: server } : { worktreeId }
}

function readEntry(value: unknown): LastVisitedWorktreeOnHost | null {
  if (!isRecord(value) || typeof value.worktreeId !== 'string' || value.worktreeId === '') {
    return null
  }
  return visitOf(
    value.worktreeId,
    typeof value.executionHost === 'string' ? value.executionHost : undefined
  )
}

function readByHost(raw: string | null): Map<string, LastVisitedWorktreeOnHost> {
  const byHost = new Map<string, LastVisitedWorktreeOnHost>()
  if (!raw) {
    return byHost
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && isRecord(parsed.byHost)) {
      for (const [hostId, value] of Object.entries(parsed.byHost)) {
        const entry = readEntry(value)
        if (entry) {
          byHost.set(hostId, entry)
        }
      }
    }
  } catch {}
  return byHost
}

export function readLastVisitedWorktreeOnHost(
  raw: string | null,
  hostId: string
): LastVisitedWorktreeOnHost | null {
  const entry = readByHost(raw).get(hostId)
  if (entry) {
    return entry
  }
  // A record written before `byHost` names only the last host, and only the desktop's own rows.
  const record = readLastVisitedWorktreeRecord(raw)
  return record?.hostId === hostId ? { worktreeId: record.worktreeId } : null
}

export function withLastVisitedWorktree(
  raw: string | null,
  record: LastVisitedWorktreeRecord & { executionHost?: ExecutionHostId }
): string {
  const byHost = readByHost(raw)
  const previous = readLastVisitedWorktreeRecord(raw)
  if (previous && !byHost.has(previous.hostId)) {
    byHost.set(previous.hostId, { worktreeId: previous.worktreeId })
  }
  // Re-inserted so the map's order is oldest visit first, which is what the cap drops.
  byHost.delete(record.hostId)
  byHost.set(record.hostId, visitOf(record.worktreeId, record.executionHost))
  const serialize = () =>
    JSON.stringify({
      hostId: record.hostId,
      worktreeId: record.worktreeId,
      byHost: Object.fromEntries(byHost)
    })
  let value = serialize()
  while (
    byHost.size > 1 &&
    (byHost.size > MAX_REMEMBERED_HOSTS || value.length > PAGE_STORAGE_MAX_VALUE_CHARS)
  ) {
    const oldest = byHost.keys().next().value
    if (oldest === undefined) {
      break
    }
    byHost.delete(oldest)
    value = serialize()
  }
  return value
}

type Listener = (hostId: string, visited: LastVisitedWorktreeOnHost) => void
const listeners = new Set<Listener>()

/** Visits noted in this JS context, told at once so an open list moves without a re-read. */
export function subscribeLastVisitedWorktree(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Notify without storing: a long-lived list’s stale page copy must not overwrite visits stored by a newer session page.
export function noteLastVisitedWorktree(
  record: LastVisitedWorktreeRecord & { executionHost?: ExecutionHostId }
): void {
  const visited = visitOf(record.worktreeId, record.executionHost)
  for (const listener of listeners) {
    listener(record.hostId, visited)
  }
}

// Serialized: each write merges into what the last one stored.
let writeChain: Promise<void> = Promise.resolve()

// Write through the shell mirror so the next page init includes the visit.
export function writeLastVisitedWorktree(
  record: LastVisitedWorktreeRecord & { executionHost?: ExecutionHostId }
): Promise<void> {
  noteLastVisitedWorktree(record)
  // Use accepted-write notification; adapters log refusals the caller cannot recover from.
  writeChain = writeChain
    .then(() => readMirroredKeyOrStore(LAST_VISITED_WORKTREE_STORAGE_KEY).catch(() => null))
    .then((raw) =>
      persistMirrored(LAST_VISITED_WORKTREE_STORAGE_KEY, withLastVisitedWorktree(raw, record))
    )
    .catch(() => {})
  return writeChain
}
