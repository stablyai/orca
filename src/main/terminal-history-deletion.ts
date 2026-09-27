import { basename, dirname, join } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { removeHostTree } from './host-tree-removal'
import { deleteFishHistoryFile, resolveFishHistoryDir } from './fish-history-session'
import { readHistoryMeta } from './terminal-history'
import {
  getHistoryRoot,
  listWslHistoryRoots,
  PENDING_DELETE_DIR_NAME
} from './terminal-history-paths'
import { hashWorktreeId } from './terminal-history-id'
import { deleteWslFishHistoryFile } from './wsl-fish-history-cleanup'

const pendingHistoryTreeRemovals = new Map<string, Promise<void>>()
export const MAX_PENDING_HISTORY_TREE_REMOVALS = 64
// Why: a tombstone that fails once (Windows EBUSY under AV) would otherwise sit on disk for the whole
// desktop session — only the next launch re-queues it. Bounded so a genuinely stuck tree stops retrying.
export const HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS = [30_000, 120_000]
const historyTreeRemovalAttempts = new Map<string, number>()
const historyTreeRemovalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const wslDistroByTombstone = new Map<string, string>()

/** One root's undrained tombstone names from the last enumeration, plus its in-flight re-read. */
type HistoryRemovalQueue = { names: string[]; refill: Promise<void> | null }
// Why hold the names instead of re-reading per completion: one `readdir` already materialises every
// name, so keeping it until it runs out makes a backlog of N tombstones cost a handful of reads, not N.
const historyRemovalQueues = new Map<string, HistoryRemovalQueue>()

function historyRemovalQueueFor(historyRoot: string): HistoryRemovalQueue {
  const existing = historyRemovalQueues.get(historyRoot)
  if (existing) {
    return existing
  }
  const queue: HistoryRemovalQueue = { names: [], refill: null }
  historyRemovalQueues.set(historyRoot, queue)
  return queue
}

function historyTreeRemovalsAtCapacity(): boolean {
  return (
    pendingHistoryTreeRemovals.size + historyTreeRemovalRetryTimers.size >=
    MAX_PENDING_HISTORY_TREE_REMOVALS
  )
}

function isHistoryTreeRemovalTracked(dir: string): boolean {
  return pendingHistoryTreeRemovals.has(dir) || historyTreeRemovalRetryTimers.has(dir)
}

/** Admit already-enumerated tombstones up to the admission cap; the rest stay queued for a later slot. */
function admitQueuedHistoryTreeRemovals(historyRoot: string, queue: HistoryRemovalQueue): void {
  const pendingRoot = getPendingDeleteRoot(historyRoot)
  const wslDistro = wslDistroForHistoryRoot(historyRoot)
  while (!historyTreeRemovalsAtCapacity()) {
    const name = queue.names.pop()
    if (name === undefined) {
      return
    }
    // Safe to re-admit a name removed since enumeration: `removeHostTree` forces the rm.
    scheduleHistoryTreeRemoval(join(pendingRoot, name), wslDistro)
  }
}

/** Re-read one root's tombstone directory, coalescing concurrent requests onto a single readdir. */
function refillHistoryRemovalQueue(historyRoot: string, queue: HistoryRemovalQueue): Promise<void> {
  if (queue.refill) {
    return queue.refill
  }
  const pendingRoot = getPendingDeleteRoot(historyRoot)
  // Why snapshot rather than only test tracking when the read lands: a removal under way now can
  // still show up in the read and also finish before it resolves, which would look admissible again.
  const removalsUnderWay = new Set(pendingHistoryTreeRemovals.keys())
  queue.refill = readTombstoneNames(historyRoot).then((names) => {
    // A teardown that dropped this queue must not resurrect its removals.
    if (historyRemovalQueues.get(historyRoot) !== queue) {
      return
    }
    queue.refill = null
    try {
      // Dropping names already handled keeps the read that confirms a drained directory from
      // re-queueing work, so the tail of a backlog does not cost one read per completion.
      queue.names = names.filter((name) => {
        const dir = join(pendingRoot, name)
        return !removalsUnderWay.has(dir) && !isHistoryTreeRemovalTracked(dir)
      })
      admitQueuedHistoryTreeRemovals(historyRoot, queue)
    } catch (err) {
      // Non-fatal, and never a rejection: callers fire this off without awaiting it.
      console.warn(
        `[pty:history] Failed to queue pending history removals: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })
  return queue.refill
}

async function readTombstoneNames(historyRoot: string): Promise<string[]> {
  try {
    return await readdir(getPendingDeleteRoot(historyRoot))
  } catch (err) {
    // An absent root is the normal steady state; anything else means tombstones may linger until a
    // later completion re-reads, so it is worth a line.
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    if (code !== 'ENOENT') {
      console.warn(
        `[pty:history] Failed to read pending history removals for ${historyRoot}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return []
  }
}

/** Reopen the admission window after a completion — from the queues, or one read once they empty. */
function replenishHistoryTreeRemovals(historyRoot: string): void {
  const queue = historyRemovalQueueFor(historyRoot)
  admitQueuedHistoryTreeRemovals(historyRoot, queue)
  // Why other roots too: a slot this root cannot fill is the only thing a sibling root displaced at
  // the cap is waiting for, and nothing else would offer it one before the next startup.
  for (const [otherRoot, otherQueue] of historyRemovalQueues) {
    if (otherQueue !== queue) {
      admitQueuedHistoryTreeRemovals(otherRoot, otherQueue)
    }
  }
  if (queue.names.length === 0 && !historyTreeRemovalsAtCapacity()) {
    void refillHistoryRemovalQueue(historyRoot, queue)
  }
}

function wslDistroForHistoryRoot(historyRoot: string): string | undefined {
  return basename(dirname(historyRoot)) === 'terminal-history-wsl'
    ? basename(historyRoot)
    : undefined
}

function getPendingDeleteRoot(historyRoot: string): string {
  return join(historyRoot, PENDING_DELETE_DIR_NAME)
}

function historyRootForTombstone(dir: string): string {
  return dirname(dirname(dir))
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
    wslDistroByTombstone.delete(dir)
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

function scheduleHistoryTreeRemoval(dir: string, wslDistro?: string): void {
  if (pendingHistoryTreeRemovals.has(dir)) {
    return
  }
  // Leave excess tombstones on disk; admission is intentionally bounded.
  if (historyTreeRemovalsAtCapacity()) {
    return
  }
  // A rescan must not cancel a delayed retry for a real failure.
  const pendingRetry = historyTreeRemovalRetryTimers.get(dir)
  if (pendingRetry) {
    return
  }
  if (wslDistro) {
    wslDistroByTombstone.set(dir, wslDistro)
  }
  let removalSucceeded = false
  const cleanupDistro = wslDistroByTombstone.get(dir)
  const meta = cleanupDistro ? readHistoryMeta(dir) : null
  const cleanup =
    cleanupDistro && meta?.fishSession
      ? // Why swallow rather than rethrow: fish history cleanup is best effort
        // and runs `wsl.exe --exec fish`, which fails outright on a distro that
        // has no fish — which is most of them. Rethrowing chained that failure
        // into removeHostTree below, so those users' history trees were never
        // reclaimed at all.
        deleteWslFishHistoryFile(cleanupDistro, meta.fishSession).catch((err: unknown) => {
          console.warn(
            `[pty:history] Failed to delete WSL fish history: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      : null
  const removal = (cleanup ? cleanup.then(() => removeHostTree(dir)) : removeHostTree(dir))
    .then(() => {
      removalSucceeded = true
      historyTreeRemovalAttempts.delete(dir)
      wslDistroByTombstone.delete(dir)
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
      if (removalSucceeded) {
        replenishHistoryTreeRemovals(historyRootForTombstone(dir))
      }
    })
  pendingHistoryTreeRemovals.set(dir, removal)
}

/** Tombstone one history tree and queue its recursive removal off the caller's critical path.
 *  Returns false when the rename failed, leaving the tree for a later GC pass to reclaim. */
export function scheduleWorktreeHistoryTreeDeletion(dir: string, historyRoot: string): boolean {
  // Why first: fish keeps its history in the user's fish data dir, outside this tree,
  // so the meta.json naming the session must still be readable when we look it up.
  const meta = readHistoryMeta(dir)
  const wslDistro = wslDistroForHistoryRoot(historyRoot)
  if (meta?.fishSession && !wslDistro) {
    // Why both directories: the recorded one is what the PTY's fish saw, this
    // process's own is the fallback when meta.json predates that field.
    deleteFishHistoryFile(meta.fishSession, [
      ...(meta.fishHistoryDir ? [meta.fishHistoryDir] : []),
      resolveFishHistoryDir()
    ])
  }
  const tombstone = tombstoneHistoryTree(dir, historyRoot)
  if (!tombstone) {
    return false
  }
  scheduleHistoryTreeRemoval(tombstone, wslDistro)
  return true
}

/** Schedule tombstoned trees under one history root for async removal — the retry after a quit mid-rm.
 *  Resolves once the enumeration landed; the removals it admitted keep draining in the background. */
export function schedulePendingHistoryTreeRemovals(historyRoot: string): Promise<void> {
  return refillHistoryRemovalQueue(historyRoot, historyRemovalQueueFor(historyRoot))
}

/** Schedule tombstoned trees under every history root, native and WSL. */
export async function scheduleAllPendingHistoryTreeRemovals(): Promise<void> {
  await Promise.all([
    schedulePendingHistoryTreeRemovals(getHistoryRoot()),
    ...listWslHistoryRoots().map((distroRoot) => schedulePendingHistoryTreeRemovals(distroRoot))
  ])
}

/** Drop queued tombstone names and retries so fixture teardown cannot resurrect a removal. Tests only. */
export function cancelPendingHistoryTreeRemovalRetries(): void {
  historyRemovalQueues.clear()
  // Why also the in-flight map: a fixture that never settles a held removal would otherwise leave it
  // for the next test's flush to wait on forever.
  pendingHistoryTreeRemovals.clear()
  for (const timer of historyTreeRemovalRetryTimers.values()) {
    clearTimeout(timer)
  }
  historyTreeRemovalRetryTimers.clear()
  historyTreeRemovalAttempts.clear()
  wslDistroByTombstone.clear()
}

/** Drain every history root's tombstones and await the in-flight removals. Tests only: production
 *  schedules the same drain from startup GC and headless serve without ever blocking on it. */
export async function flushPendingWorktreeHistoryDeletions(): Promise<void> {
  await scheduleAllPendingHistoryTreeRemovals()
  // Why loop: awaiting one snapshot of the map would return with a removal scheduled mid-batch still
  // in flight. Each pass admits every queued name the cap allows, then settles what is outstanding.
  while (true) {
    for (const [root, queue] of historyRemovalQueues) {
      admitQueuedHistoryTreeRemovals(root, queue)
    }
    const outstanding = [
      ...pendingHistoryTreeRemovals.values(),
      ...[...historyRemovalQueues.values()].flatMap((queue) => (queue.refill ? [queue.refill] : []))
    ]
    if (outstanding.length === 0) {
      // Nothing in flight and nothing admissible: only delayed retries can still make progress.
      return
    }
    await Promise.all(outstanding)
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
