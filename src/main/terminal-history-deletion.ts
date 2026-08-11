import { basename, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { removeHostTree } from './host-tree-removal'
import {
  getHistoryRoot,
  hashWorktreeId,
  listWslHistoryRoots,
  PENDING_DELETE_DIR_NAME
} from './terminal-history-paths'

const pendingHistoryTreeRemovals = new Map<string, Promise<void>>()
// Why: a tombstone that fails once (Windows EBUSY under AV) would otherwise sit on disk for the whole
// desktop session — only the next launch re-queues it. Bounded so a genuinely stuck tree stops retrying.
export const HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS = [30_000, 120_000]
const historyTreeRemovalAttempts = new Map<string, number>()
const historyTreeRemovalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function getPendingDeleteRoot(historyRoot: string): string {
  return join(historyRoot, PENDING_DELETE_DIR_NAME)
}

/** Move a history tree to a pending-delete tombstone (metadata-only) so the critical path never walks it. */
function tombstoneHistoryTree(dir: string, historyRoot: string): string | null {
  if (!existsSync(dir)) {
    return null
  }
  const pendingRoot = getPendingDeleteRoot(historyRoot)
  try {
    if (!existsSync(pendingRoot)) {
      mkdirSync(pendingRoot, { recursive: true })
    }
    const tombstone = join(
      pendingRoot,
      `${basename(dir)}.${Date.now()}.${Math.random().toString(16).slice(2)}`
    )
    renameSync(dir, tombstone)
    return tombstone
  } catch (err) {
    console.warn(
      `[pty:history] Failed to tombstone history dir: ${err instanceof Error ? err.message : String(err)}`
    )
    // Why: never schedule an async rm of the live path — worktree IDs are path-derived, so a recreated
    // worktree can own this directory again before the rm lands. GC reclaims it by meta.worktreeId instead.
    return null
  }
}

function scheduleHistoryTreeRemovalRetry(dir: string): void {
  const attempt = historyTreeRemovalAttempts.get(dir) ?? 0
  const retryDelayMs = HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS[attempt]
  if (retryDelayMs === undefined) {
    // Out of in-process attempts: the tombstone stays on disk and the next startup drain re-queues it.
    historyTreeRemovalAttempts.delete(dir)
    return
  }
  historyTreeRemovalAttempts.set(dir, attempt + 1)
  const timer = setTimeout(() => {
    historyTreeRemovalRetryTimers.delete(dir)
    scheduleHistoryTreeRemoval(dir)
  }, retryDelayMs)
  timer.unref?.()
  historyTreeRemovalRetryTimers.set(dir, timer)
}

function scheduleHistoryTreeRemoval(dir: string): void {
  if (pendingHistoryTreeRemovals.has(dir)) {
    return
  }
  // A rescan (GC / startup drain) hitting the same tombstone supersedes its pending retry.
  const pendingRetry = historyTreeRemovalRetryTimers.get(dir)
  if (pendingRetry) {
    clearTimeout(pendingRetry)
    historyTreeRemovalRetryTimers.delete(dir)
  }
  const removal = removeHostTree(dir)
    .then(() => {
      historyTreeRemovalAttempts.delete(dir)
    })
    .catch((err: unknown) => {
      console.warn(
        `[pty:history] Failed to delete history dir: ${err instanceof Error ? err.message : String(err)}`
      )
      scheduleHistoryTreeRemovalRetry(dir)
    })
    .finally(() => {
      if (pendingHistoryTreeRemovals.get(dir) === removal) {
        pendingHistoryTreeRemovals.delete(dir)
      }
    })
  pendingHistoryTreeRemovals.set(dir, removal)
}

/** Tombstone one history tree and queue its recursive removal off the caller's critical path.
 *  Returns false when the rename failed, leaving the tree for a later GC pass to reclaim. */
export function scheduleWorktreeHistoryTreeDeletion(dir: string, historyRoot: string): boolean {
  const tombstone = tombstoneHistoryTree(dir, historyRoot)
  if (!tombstone) {
    return false
  }
  scheduleHistoryTreeRemoval(tombstone)
  return true
}

/** Schedule tombstoned trees under one history root for async removal — the retry after a quit mid-rm. */
export function schedulePendingHistoryTreeRemovals(historyRoot: string): void {
  const pendingRoot = getPendingDeleteRoot(historyRoot)
  if (!existsSync(pendingRoot)) {
    return
  }
  try {
    for (const entry of readdirSync(pendingRoot)) {
      scheduleHistoryTreeRemoval(join(pendingRoot, entry))
    }
  } catch {
    // Non-fatal.
  }
}

/** Schedule tombstoned trees under every history root, native and WSL. */
export function scheduleAllPendingHistoryTreeRemovals(): void {
  schedulePendingHistoryTreeRemovals(getHistoryRoot())
  for (const distroRoot of listWslHistoryRoots()) {
    schedulePendingHistoryTreeRemovals(distroRoot)
  }
}

/** Drop every armed retry timer so a fixture teardown cannot resurrect a removal. Tests only. */
export function cancelPendingHistoryTreeRemovalRetries(): void {
  for (const timer of historyTreeRemovalRetryTimers.values()) {
    clearTimeout(timer)
  }
  historyTreeRemovalRetryTimers.clear()
  historyTreeRemovalAttempts.clear()
}

/** Drain every history root's tombstones and await the in-flight removals. Tests only: production
 *  schedules the same drain from startup GC and headless serve without ever blocking on it. */
export async function flushPendingWorktreeHistoryDeletions(): Promise<void> {
  scheduleAllPendingHistoryTreeRemovals()
  // Why loop: awaiting one snapshot of the map would return with a removal scheduled mid-batch still
  // in flight. Each pass settles its batch and drains whatever was added while it ran.
  while (pendingHistoryTreeRemovals.size > 0) {
    await Promise.all(pendingHistoryTreeRemovals.values())
  }
}

/** Delete the history directory for a removed worktree. Non-fatal; never blocks on recursive rm. */
export function deleteWorktreeHistoryDir(worktreeId: string): void {
  const worktreeHash = hashWorktreeId(worktreeId)
  const historyRoot = getHistoryRoot()
  try {
    if (scheduleWorktreeHistoryTreeDeletion(join(historyRoot, worktreeHash), historyRoot)) {
      console.log(`[pty:history] Scheduled history delete for worktree ${worktreeId}`)
    }
  } catch (err) {
    console.warn(
      `[pty:history] Failed to schedule history delete: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // Also clean up WSL history for this worktree; listWslHistoryRoots is empty where WSL never ran.
  try {
    for (const distroRoot of listWslHistoryRoots()) {
      scheduleWorktreeHistoryTreeDeletion(join(distroRoot, worktreeHash), distroRoot)
    }
  } catch (err) {
    console.warn(
      `[pty:history] Failed to schedule WSL history delete: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
