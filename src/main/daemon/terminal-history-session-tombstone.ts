// Why: worktree teardown stops every terminal one by one, and each stop used to await a full recursive
// delete of that session's history tree (hundreds of MB). Rename the tree into a tombstone queue instead
// so the stop-and-wait path is metadata-only, and drain the queue off the critical path.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { removeHostTree } from '../host-tree-removal'
import { getHistorySessionDirName } from './history-paths'
import { getTerminalHistoryQuarantineOwnerDir } from './terminal-history-recovery-quarantine'

const PENDING_DELETE_DIR_NAME = '.pending-delete'

const pendingSessionTreeRemovals = new Map<string, Promise<void>>()
// Why: a tombstone whose rm fails once (Windows EBUSY under AV) would otherwise sit on disk until the
// next HistoryManager construction. Bounded so a genuinely wedged tree stops burning timers.
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
    mkdirSync(pendingRoot, { recursive: true })
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
    // Out of in-process attempts: the tombstone stays queued for the next construction's drain.
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
  // A rescan (startup drain) hitting the same tombstone supersedes its pending retry.
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

/** Remove everything a session owns on disk — its history tree and any quarantined generations —
 *  without holding the caller for the recursive walks. Both are unreachable once this resolves;
 *  only the reclaim is detached. */
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
  // Rename blocked (open handles under Windows AV); remove in place so the tree is still gone on return.
  await removeHostTree(dir)
}

/** Queue tombstones left by a crash or quit mid-removal. Cheap no-op when the queue never formed. */
export function schedulePendingSessionTreeRemovals(basePath: string): void {
  const pendingRoot = getPendingDeleteRoot(basePath)
  try {
    for (const entry of readdirSync(pendingRoot)) {
      scheduleSessionTreeRemoval(join(pendingRoot, entry))
    }
  } catch {
    // Missing or unreadable queue is non-fatal; the next construction rescans.
  }
}

/** Drop every armed retry timer so a fixture teardown cannot resurrect a removal. Tests only. */
export function cancelPendingSessionTreeRemovalRetries(): void {
  for (const timer of sessionTreeRemovalRetryTimers.values()) {
    clearTimeout(timer)
  }
  sessionTreeRemovalRetryTimers.clear()
  sessionTreeRemovalAttempts.clear()
}

/** Await the in-flight tombstone removals. Tests only — production reclaims off the critical path and
 *  re-queues whatever a quit interrupted on the next HistoryManager construction. */
export async function flushPendingSessionTreeRemovals(): Promise<void> {
  while (pendingSessionTreeRemovals.size > 0) {
    await Promise.all(pendingSessionTreeRemovals.values())
  }
}
