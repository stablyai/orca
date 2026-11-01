import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import {
  getHistoryRoot,
  listWslHistoryRoots,
  PENDING_DELETE_DIR_NAME
} from './terminal-history-paths'
import {
  schedulePendingHistoryTreeRemovals,
  scheduleWorktreeHistoryTreeDeletion
} from './terminal-history-deletion'
import { readHistoryMetaAsync } from './terminal-history'
import { resolveFishHistoryDir, sweepOrphanedFishHistoryFiles } from './fish-history-session'
import { hashWorktreeId } from './terminal-history-id'
import { forEachWithConcurrency } from '../shared/map-with-concurrency'
import { yieldToEventLoop } from '../shared/event-loop-yield'

// Protect history created after the live-worktree snapshot was taken.
const GC_MIN_AGE_MS = 5 * 60 * 1000

// Bound filesystem fan-out so large roots do not monopolize startup I/O.
const HISTORY_GC_SCAN_CONCURRENCY = 16
// Cached I/O can resolve entirely in microtasks; yield so timers still run.
const HISTORY_GC_YIELD_EVERY = 32

let scheduledHistoryGcTimer: ReturnType<typeof setTimeout> | null = null
let historyGcStarting = false
let historyGcCancelled = false
let activeHistoryGc: Promise<void> | null = null
let activeHistoryGcAbort: AbortController | null = null

type GcRootScan = {
  totalDirs: number
  orphaned: number
  pruned: number
  fishHistoryDirs: Set<string>
}

async function gcScanEntry(
  root: string,
  entry: Dirent,
  liveWorktreeIds: Set<string>,
  now: number,
  result: GcRootScan
): Promise<void> {
  const entryPath = join(root, entry.name)
  try {
    // Dirents describe links, so symlinked directories still need a stat.
    const isDirectory = entry.isSymbolicLink()
      ? (await stat(entryPath)).isDirectory()
      : entry.isDirectory()
    if (!isDirectory) {
      return
    }
    result.totalDirs++

    // Keep entries whose ownership cannot be established.
    const meta = await readHistoryMetaAsync(entryPath)
    if (meta?.fishHistoryDir) {
      result.fishHistoryDirs.add(meta.fishHistoryDir)
    }
    if (!meta?.worktreeId) {
      return
    }

    if (!liveWorktreeIds.has(meta.worktreeId)) {
      if (meta.createdAt) {
        const ageMs = now - new Date(meta.createdAt).getTime()
        if (ageMs < GC_MIN_AGE_MS) {
          return
        }
      }

      result.orphaned++
      // Tombstone before async removal to avoid a recursive walk on the main thread.
      if (scheduleWorktreeHistoryTreeDeletion(entryPath, root)) {
        result.pruned++
        console.log(`[pty:history:gc] Pruned orphaned history: ${meta.worktreeId}`)
      }
    }
  } catch {
    // Unreadable entries must not prevent collecting the rest.
  }
}

async function gcScanRoot(
  root: string,
  liveWorktreeIds: Set<string>,
  signal: AbortSignal
): Promise<GcRootScan> {
  const result: GcRootScan = {
    totalDirs: 0,
    orphaned: 0,
    pruned: 0,
    fishHistoryDirs: new Set<string>()
  }

  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result
  }

  const now = Date.now()
  const frontier = entries.filter((entry) => entry.name !== PENDING_DELETE_DIR_NAME)

  await forEachWithConcurrency(
    frontier,
    HISTORY_GC_SCAN_CONCURRENCY,
    async (entry, index): Promise<void> => {
      if (signal.aborted) {
        return
      }
      await gcScanEntry(root, entry, liveWorktreeIds, now, result)
      if (index % HISTORY_GC_YIELD_EVERY === HISTORY_GC_YIELD_EVERY - 1) {
        await yieldToEventLoop()
      }
    }
  )
  return result
}

async function executeHistoryGc(liveWorktreeIds: Set<string>, signal: AbortSignal): Promise<void> {
  try {
    // Previously tombstoned entries are safe to drain even if the live set below is unavailable.
    await schedulePendingHistoryTreeRemovals(getHistoryRoot())
    // An empty live set may mean state loading failed; do not delete recoverable history.
    if (liveWorktreeIds.size === 0) {
      console.log('[pty:history:gc] Skipped: live worktree set is empty')
      return
    }
    const main = await gcScanRoot(getHistoryRoot(), liveWorktreeIds, signal)

    const wslTotals = { totalDirs: 0, orphaned: 0, pruned: 0 }
    const liveFishHistoryDirs = new Set(main.fishHistoryDirs)
    for (const distroRoot of listWslHistoryRoots()) {
      if (signal.aborted) {
        break
      }
      await schedulePendingHistoryTreeRemovals(distroRoot)
      const r = await gcScanRoot(distroRoot, liveWorktreeIds, signal)
      wslTotals.totalDirs += r.totalDirs
      wslTotals.orphaned += r.orphaned
      wslTotals.pruned += r.pruned
      for (const dir of r.fishHistoryDirs) {
        liveFishHistoryDirs.add(dir)
      }
    }

    if (signal.aborted) {
      console.log('[pty:history:gc] Cancelled mid-scan')
      return
    }

    // Fish files can outlive their metadata; include recorded dirs in case XDG_DATA_HOME changed.
    const fishDirs = new Set([resolveFishHistoryDir()])
    for (const dir of liveFishHistoryDirs) {
      fishDirs.add(dir)
    }
    const fishOrphans = sweepOrphanedFishHistoryFiles(
      new Set([...liveWorktreeIds].map(hashWorktreeId)),
      fishDirs,
      GC_MIN_AGE_MS
    )
    if (fishOrphans > 0) {
      console.log(`[pty:history:gc] Swept ${fishOrphans} orphaned fish history file(s)`)
    }

    const totalDirs = main.totalDirs + wslTotals.totalDirs
    const orphaned = main.orphaned + wslTotals.orphaned
    const pruned = main.pruned + wslTotals.pruned

    console.log(`[pty:history:gc] totalDirs=${totalDirs} orphaned=${orphaned} pruned=${pruned}`)
  } catch (err) {
    console.warn(`[pty:history:gc] GC failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function runHistoryGc(liveWorktreeIds: Set<string>): Promise<void> {
  // Concurrent passes would race each other's tombstone renames.
  if (activeHistoryGc) {
    return activeHistoryGc
  }
  const controller = new AbortController()
  activeHistoryGcAbort = controller
  activeHistoryGc = executeHistoryGc(liveWorktreeIds, controller.signal).finally(() => {
    activeHistoryGc = null
    activeHistoryGcAbort = null
  })
  return activeHistoryGc
}

export function cancelHistoryGc(): void {
  if (scheduledHistoryGcTimer !== null) {
    clearTimeout(scheduledHistoryGcTimer)
    scheduledHistoryGcTimer = null
  }
  // The timer may have fired before live-worktree lookup settles and a controller exists.
  historyGcCancelled = true
  activeHistoryGcAbort?.abort()
}

/** Use already-known worktree IDs; do not probe repo paths. */
export function scheduleHistoryGc(getLiveWorktreeIds: () => Promise<Set<string>>): void {
  if (scheduledHistoryGcTimer !== null || historyGcStarting || activeHistoryGc !== null) {
    return
  }
  historyGcCancelled = false
  // Let workspace hydration finish before competing for disk I/O.
  scheduledHistoryGcTimer = setTimeout(async () => {
    scheduledHistoryGcTimer = null
    historyGcStarting = true
    try {
      const liveIds = await getLiveWorktreeIds()
      if (historyGcCancelled) {
        return
      }
      await runHistoryGc(liveIds)
    } catch (err) {
      console.warn(
        `[pty:history:gc] Failed to enumerate live worktrees for GC: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      historyGcStarting = false
    }
  }, 10_000)
}
