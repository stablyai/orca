// Tombstone history trees so terminal teardown can defer large recursive deletions.

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { removeHostTree } from '../host-tree-removal'
import { ensurePrivateDir } from './daemon-private-file-modes'
import { getHistorySessionDirName } from './history-paths'
import { getTerminalHistoryQuarantineOwnerDir } from './terminal-history-recovery-quarantine'

const PENDING_DELETE_DIR_NAME = '.pending-delete'

const pendingSessionTreeRemovals = new Map<string, Promise<void>>()
// Retry transient deletion failures in-process; bound retries for persistently locked trees.
export const SESSION_TREE_REMOVAL_RETRY_DELAYS_MS = [30_000, 120_000]
const sessionTreeRemovalAttempts = new Map<string, number>()
const sessionTreeRemovalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function isTerminalHistoryPendingDeleteEntry(name: string): boolean {
  return name === PENDING_DELETE_DIR_NAME
}

function getPendingDeleteRoot(basePath: string): string {
  return join(basePath, PENDING_DELETE_DIR_NAME)
}

function tombstoneSessionTree(basePath: string, dir: string): string | null {
  const pendingRoot = getPendingDeleteRoot(basePath)
  try {
    ensurePrivateDir(pendingRoot)
    const tombstone = join(pendingRoot, randomUUID())
    renameSync(dir, tombstone)
    return tombstone
  } catch {
    return null
  }
}

function scheduleSessionTreeRemovalRetry(dir: string): void {
  const attempt = sessionTreeRemovalAttempts.get(dir) ?? 0
  const retryDelayMs = SESSION_TREE_REMOVAL_RETRY_DELAYS_MS[attempt]
  if (retryDelayMs === undefined) {
    // Leave exhausted tombstones queued for the next startup drain.
    sessionTreeRemovalAttempts.delete(dir)
    return
  }
  sessionTreeRemovalAttempts.set(dir, attempt + 1)
  const timer = setTimeout(() => {
    sessionTreeRemovalRetryTimers.delete(dir)
    scheduleSessionTreeRemoval(dir)
  }, retryDelayMs)
  timer.unref?.()
  sessionTreeRemovalRetryTimers.set(dir, timer)
}

function scheduleSessionTreeRemoval(dir: string): void {
  if (pendingSessionTreeRemovals.has(dir)) {
    return
  }
  // A startup rescan supersedes any pending retry.
  const pendingRetry = sessionTreeRemovalRetryTimers.get(dir)
  if (pendingRetry) {
    clearTimeout(pendingRetry)
    sessionTreeRemovalRetryTimers.delete(dir)
  }
  const removal = removeHostTree(dir)
    .then(() => {
      sessionTreeRemovalAttempts.delete(dir)
    })
    .catch((err: unknown) => {
      console.warn(
        `[history] Failed to delete tombstoned session tree: ${err instanceof Error ? err.message : String(err)}`
      )
      scheduleSessionTreeRemovalRetry(dir)
    })
    .finally(() => {
      if (pendingSessionTreeRemovals.get(dir) === removal) {
        pendingSessionTreeRemovals.delete(dir)
      }
    })
  pendingSessionTreeRemovals.set(dir, removal)
}

/** Make session trees unreachable before return; successful renames defer physical deletion. */
export async function removeTerminalHistorySessionTrees(
  basePath: string,
  sessionId: string
): Promise<void> {
  for (const dir of [
    join(basePath, getHistorySessionDirName(sessionId)),
    getTerminalHistoryQuarantineOwnerDir(basePath, sessionId)
  ]) {
    await removeSessionOwnedTree(basePath, dir)
  }
}

async function removeSessionOwnedTree(basePath: string, dir: string): Promise<void> {
  if (!existsSync(dir)) {
    return
  }
  const tombstone = tombstoneSessionTree(basePath, dir)
  if (tombstone) {
    scheduleSessionTreeRemoval(tombstone)
    return
  }
  // Fall back to awaited deletion when renaming fails.
  await removeHostTree(dir)
}

export function schedulePendingSessionTreeRemovals(basePath: string): void {
  const pendingRoot = getPendingDeleteRoot(basePath)
  try {
    for (const entry of readdirSync(pendingRoot)) {
      scheduleSessionTreeRemoval(join(pendingRoot, entry))
    }
  } catch {
    // A later construction can rescan an unreadable queue.
  }
}

/** Tests only: prevent retry timers from reviving removals after fixture teardown. */
export function cancelPendingSessionTreeRemovalRetries(): void {
  for (const timer of sessionTreeRemovalRetryTimers.values()) {
    clearTimeout(timer)
  }
  sessionTreeRemovalRetryTimers.clear()
  sessionTreeRemovalAttempts.clear()
}

/** Tests only: wait for current removals; production reclaims asynchronously. */
export async function flushPendingSessionTreeRemovals(): Promise<void> {
  while (pendingSessionTreeRemovals.size > 0) {
    await Promise.all(pendingSessionTreeRemovals.values())
  }
}
