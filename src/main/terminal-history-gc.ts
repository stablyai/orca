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

// Why 5 minutes: GC runs ~10s after startup, and the live-worktree snapshot is
// taken just before. A worktree created between the snapshot and GC execution
// won't appear in liveWorktreeIds, so without an age guard GC would delete its
// freshly-created history directory (TOCTOU race). 5 minutes is generous enough
// to cover any realistic snapshot-to-scan delay.
const GC_MIN_AGE_MS = 5 * 60 * 1000

// Why a fixed worker pool over a frontier and not per-entry promise fan-out: a real
// history root holds thousands of directories, and starting every one at once queues
// tens of thousands of libuv requests before the first completes. 16 is deep enough to
// keep the default 4-thread pool saturated without monopolising the disk during startup.
const HISTORY_GC_SCAN_CONCURRENCY = 16
// Why yield at all when every step already awaits I/O: a fully cached root resolves each
// await in a microtask, which never returns to the macrotask queue. This bounds that run.
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
  /** Every fish data dir a meta.json in this root names, for the orphan sweep. */
  fishHistoryDirs: Set<string>
}

/** Inspect one history directory, tombstoning it when its worktree is gone. */
async function gcScanEntry(
  root: string,
  entry: Dirent,
  liveWorktreeIds: Set<string>,
  now: number,
  result: GcRootScan
): Promise<void> {
  const entryPath = join(root, entry.name)
  try {
    // Why stat only for links: a dirent describes the link itself, and the pre-dirent walk
    // stat'd every entry, so a symlink to a history directory was and stays a directory here.
    const isDirectory = entry.isSymbolicLink()
      ? (await stat(entryPath)).isDirectory()
      : entry.isDirectory()
    if (!isDirectory) {
      return
    }
    result.totalDirs++

    // A missing, truncated, oversized or malformed meta.json reads back as null, and a
    // null meta is never pruned — an entry whose ownership we cannot establish is kept.
    const meta = await readHistoryMetaAsync(entryPath)
    if (meta?.fishHistoryDir) {
      result.fishHistoryDirs.add(meta.fishHistoryDir)
    }
    if (!meta?.worktreeId) {
      return
    }

    if (!liveWorktreeIds.has(meta.worktreeId)) {
      // Why: avoid a TOCTOU race where a worktree is created after the
      // live-ID snapshot but before GC runs. Directories younger than
      // GC_MIN_AGE_MS are presumed still live and skipped.
      if (meta.createdAt) {
        const ageMs = now - new Date(meta.createdAt).getTime()
        if (ageMs < GC_MIN_AGE_MS) {
          return
        }
      }

      result.orphaned++
      // Why: a large orphaned tree recursive-rm'd here would stall the main process ~10s after
      // launch — the same freeze the explicit-delete path already tombstones its way out of.
      if (scheduleWorktreeHistoryTreeDeletion(entryPath, root)) {
        result.pruned++
        console.log(`[pty:history:gc] Pruned orphaned history: ${meta.worktreeId}`)
      }
    }
  } catch {
    // Skip individual entries that fail.
  }
}

/** Scan a single history root directory, pruning orphaned entries. */
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
    // Why withFileTypes: the root listing already carries each entry's type, so asking for it
    // here removes one stat per history directory from the startup pass.
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // Absent or unreadable root: nothing to collect.
    return result
  }

  const now = Date.now()
  // Why: pending-delete is a tombstone queue drained asynchronously, not a live worktree hash.
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
    // Why: finish tombstones left by quit mid-rm before scanning live worktree hashes.
    // Safe ahead of the guard below: these entries were already condemned by a
    // completed GC, and leaving them renamed-but-present strands disk forever.
    schedulePendingHistoryTreeRemovals(getHistoryRoot())
    // Why refuse rather than treat every entry as orphaned: an empty live set is
    // what a store that fell back to default state looks like, and it cannot be
    // told apart from a user who genuinely has no worktrees — who also has no
    // history to collect. So refusing costs nothing, and it is the difference
    // between a recoverable bad load and every worktree's shell history being
    // deleted. `sweepOrphanedFishHistoryFiles` refuses it for the same reason;
    // this is the path that deletes more.
    if (liveWorktreeIds.size === 0) {
      console.log('[pty:history:gc] Skipped: live worktree set is empty')
      return
    }
    const main = await gcScanRoot(getHistoryRoot(), liveWorktreeIds, signal)

    // Also scan WSL history directories (each distro has its own subdirectory).
    const wslTotals = { totalDirs: 0, orphaned: 0, pruned: 0 }
    const liveFishHistoryDirs = new Set(main.fishHistoryDirs)
    for (const distroRoot of listWslHistoryRoots()) {
      if (signal.aborted) {
        break
      }
      schedulePendingHistoryTreeRemovals(distroRoot)
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

    // Why a sweep on top of per-worktree deletion: a fish history file lives in
    // the user's fish data dir, so it outlives the directory that names it. A
    // crash between tombstone and removal, or a hand-deleted history dir, leaves
    // one with nothing left to point at it. Collecting the dirs the live meta
    // files name covers a machine whose XDG_DATA_HOME changed between runs.
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

/** Run background GC to prune history directories for worktrees that are no
 *  longer in Orca's known live-worktree set. Resolves when the pass finishes. */
export function runHistoryGc(liveWorktreeIds: Set<string>): Promise<void> {
  // Why join instead of starting a second pass: two walks would race each other's
  // tombstone renames, and the loser's `scheduleWorktreeHistoryTreeDeletion` would
  // report a failure for a directory the winner already condemned.
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

/** Drop a pending GC and stop an in-flight walk at its next entry. */
export function cancelHistoryGc(): void {
  if (scheduledHistoryGcTimer !== null) {
    clearTimeout(scheduledHistoryGcTimer)
    scheduledHistoryGcTimer = null
  }
  // Why a flag as well: the timer has already fired while the live-worktree lookup is
  // in flight, and there is no controller to abort until the scan itself starts.
  historyGcCancelled = true
  activeHistoryGcAbort?.abort()
}

/** Schedule GC after a delay so it runs after workspace hydration completes.
 *  `getLiveWorktreeIds` should use already-known IDs, not probe repo paths. */
export function scheduleHistoryGc(getLiveWorktreeIds: () => Promise<Set<string>>): void {
  // Why: main-window services can reattach during reload/reactivation; one
  // pending/running disk GC is enough and avoids duplicate startup I/O.
  if (scheduledHistoryGcTimer !== null || historyGcStarting || activeHistoryGc !== null) {
    return
  }
  historyGcCancelled = false
  // Why 10s: avoids competing with startup-critical I/O while still running
  // early enough to clean up before the user notices disk usage (§7.6).
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
