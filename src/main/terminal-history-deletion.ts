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
import { deferUntilWslDistroRunning } from './wsl-background-distro-gate'

const pendingHistoryTreeRemovals = new Map<string, Promise<void>>()
export const MAX_PENDING_HISTORY_TREE_REMOVALS = 64
// Retry transient failures such as Windows EBUSY without polling a stuck tree indefinitely.
export const HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS = [30_000, 120_000]
const historyTreeRemovalAttempts = new Map<string, number>()
const historyTreeRemovalRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const wslDistroByTombstone = new Map<string, string>()
// Stopped distros retain tombstones without holding admission slots.
const tombstonesAwaitingWslDistro = new Set<string>()

type HistoryRemovalQueue = { names: string[]; refill: Promise<void> | null }
// Keep enumerated names so a backlog needs a handful of directory reads, not one per removal.
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
  return (
    pendingHistoryTreeRemovals.has(dir) ||
    historyTreeRemovalRetryTimers.has(dir) ||
    tombstonesAwaitingWslDistro.has(dir)
  )
}

function admitQueuedHistoryTreeRemovals(historyRoot: string, queue: HistoryRemovalQueue): void {
  const pendingRoot = getPendingDeleteRoot(historyRoot)
  const wslDistro = wslDistroForHistoryRoot(historyRoot)
  while (!historyTreeRemovalsAtCapacity()) {
    const name = queue.names.pop()
    if (name === undefined) {
      return
    }
    // removeHostTree tolerates names removed since enumeration.
    scheduleHistoryTreeRemoval(join(pendingRoot, name), wslDistro)
  }
}

function refillHistoryRemovalQueue(historyRoot: string, queue: HistoryRemovalQueue): Promise<void> {
  if (queue.refill) {
    return queue.refill
  }
  const pendingRoot = getPendingDeleteRoot(historyRoot)
  // A removal can finish during readdir; exclude it even after its tracking entry disappears.
  const removalsUnderWay = new Set(pendingHistoryTreeRemovals.keys())
  queue.refill = readTombstoneNames(historyRoot).then((names) => {
    if (historyRemovalQueues.get(historyRoot) !== queue) {
      return
    }
    queue.refill = null
    try {
      queue.names = names.filter((name) => {
        const dir = join(pendingRoot, name)
        return !removalsUnderWay.has(dir) && !isHistoryTreeRemovalTracked(dir)
      })
      admitQueuedHistoryTreeRemovals(historyRoot, queue)
    } catch (err) {
      // Background callers do not await this promise; report failures without rejecting.
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
    // Missing roots are normal; other errors can strand tombstones until a later refill.
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    if (code !== 'ENOENT') {
      console.warn(
        `[pty:history] Failed to read pending history removals for ${historyRoot}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    return []
  }
}

function replenishHistoryTreeRemovals(historyRoot: string): void {
  const queue = historyRemovalQueueFor(historyRoot)
  admitQueuedHistoryTreeRemovals(historyRoot, queue)
  // Offer freed slots to sibling roots that hit the shared admission cap.
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

// Rename first so the caller never recursively walks the live tree.
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
    // Never remove the live path asynchronously: a recreated worktree may already own it.
    return null
  }
}

function scheduleHistoryTreeRemovalRetry(dir: string): void {
  const attempt = historyTreeRemovalAttempts.get(dir) ?? 0
  const retryDelayMs = HISTORY_TREE_REMOVAL_RETRY_DELAYS_MS[attempt]
  if (retryDelayMs === undefined) {
    // Keep the tombstone on disk for a later startup drain.
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
  if (pendingHistoryTreeRemovals.has(dir) || tombstonesAwaitingWslDistro.has(dir)) {
    return
  }
  if (historyTreeRemovalsAtCapacity()) {
    return
  }
  const pendingRetry = historyTreeRemovalRetryTimers.get(dir)
  if (pendingRetry) {
    return
  }
  if (wslDistro) {
    wslDistroByTombstone.set(dir, wslDistro)
  }
  let removalSucceeded = false
  let awaitingDistro = false
  const cleanupDistro = wslDistroByTombstone.get(dir)
  const meta = cleanupDistro ? readHistoryMeta(dir) : null
  const cleanup =
    cleanupDistro && meta?.fishSession
      ? // Missing fish must not block removal of the other history files.
        deleteWslFishHistoryFile(cleanupDistro, meta.fishSession).catch((err: unknown) => {
          console.warn(
            `[pty:history] Failed to delete WSL fish history: ${err instanceof Error ? err.message : String(err)}`
          )
          return undefined
        })
      : null
  const removal = (
    cleanup
      ? cleanup.then((outcome) => {
          // meta.json is the only record of the guest-side file; retain it while its distro is stopped.
          awaitingDistro = outcome === 'distro-stopped'
          return awaitingDistro ? undefined : removeHostTree(dir)
        })
      : removeHostTree(dir)
  )
    .then(() => {
      removalSucceeded = !awaitingDistro
      if (removalSucceeded) {
        historyTreeRemovalAttempts.delete(dir)
        wslDistroByTombstone.delete(dir)
      }
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
      if (awaitingDistro && cleanupDistro) {
        tombstonesAwaitingWslDistro.add(dir)
        deferUntilWslDistroRunning(cleanupDistro, `history-tombstone:${dir}`, () => {
          if (tombstonesAwaitingWslDistro.delete(dir)) {
            scheduleHistoryTreeRemoval(dir)
          }
        })
      }
      if (removalSucceeded || awaitingDistro) {
        replenishHistoryTreeRemovals(historyRootForTombstone(dir))
      }
    })
  pendingHistoryTreeRemovals.set(dir, removal)
}

/** Returns false if tombstoning fails; leave the live tree for a later GC pass. */
export function scheduleWorktreeHistoryTreeDeletion(dir: string, historyRoot: string): boolean {
  // Read metadata before renaming; fish stores its history outside this tree.
  const meta = readHistoryMeta(dir)
  const wslDistro = wslDistroForHistoryRoot(historyRoot)
  if (meta?.fishSession && !wslDistro) {
    // Old metadata lacks the spawn-time directory; fall back to this process's fish data dir.
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

/** Resolves after enumeration; admitted removals keep draining in the background. */
export function schedulePendingHistoryTreeRemovals(historyRoot: string): Promise<void> {
  return refillHistoryRemovalQueue(historyRoot, historyRemovalQueueFor(historyRoot))
}

export async function scheduleAllPendingHistoryTreeRemovals(): Promise<void> {
  await Promise.all([
    schedulePendingHistoryTreeRemovals(getHistoryRoot()),
    ...listWslHistoryRoots().map((distroRoot) => schedulePendingHistoryTreeRemovals(distroRoot))
  ])
}

/** Tests only: prevent queued removals and retries from surviving fixture teardown. */
export function cancelPendingHistoryTreeRemovalRetries(): void {
  historyRemovalQueues.clear()
  // Held test removals must not leave the next test's flush waiting forever.
  pendingHistoryTreeRemovals.clear()
  for (const timer of historyTreeRemovalRetryTimers.values()) {
    clearTimeout(timer)
  }
  historyTreeRemovalRetryTimers.clear()
  historyTreeRemovalAttempts.clear()
  wslDistroByTombstone.clear()
  tombstonesAwaitingWslDistro.clear()
}

/** Tests only: await admitted removals; production drains in the background. */
export async function flushPendingWorktreeHistoryDeletions(): Promise<void> {
  await scheduleAllPendingHistoryTreeRemovals()
  // Removals scheduled mid-batch must be included before returning.
  while (true) {
    for (const [root, queue] of historyRemovalQueues) {
      admitQueuedHistoryTreeRemovals(root, queue)
    }
    const outstanding = [
      ...pendingHistoryTreeRemovals.values(),
      ...[...historyRemovalQueues.values()].flatMap((queue) => (queue.refill ? [queue.refill] : []))
    ]
    if (outstanding.length === 0) {
      // Delayed retries are intentionally left to their timers.
      return
    }
    await Promise.all(outstanding)
  }
}

// Never recursively remove history on the caller's critical path.
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
