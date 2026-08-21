import { join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import {
  getHistoryRoot,
  listWslHistoryRoots,
  PENDING_DELETE_DIR_NAME
} from './terminal-history-paths'
import {
  schedulePendingHistoryTreeRemovals,
  scheduleWorktreeHistoryTreeDeletion
} from './terminal-history-deletion'
import { readHistoryMeta } from './terminal-history'
import { resolveFishHistoryDir, sweepOrphanedFishHistoryFiles } from './fish-history-session'
import { hashWorktreeId } from './terminal-history-id'

// Why 5 minutes: GC runs ~10s after startup, and the live-worktree snapshot is
// taken just before. A worktree created between the snapshot and GC execution
// won't appear in liveWorktreeIds, so without an age guard GC would delete its
// freshly-created history directory (TOCTOU race). 5 minutes is generous enough
// to cover any realistic snapshot-to-scan delay.
const GC_MIN_AGE_MS = 5 * 60 * 1000

let scheduledHistoryGcTimer: ReturnType<typeof setTimeout> | null = null
let historyGcRunning = false

/** Scan a single history root directory, pruning orphaned entries.
 *  Returns { totalDirs, orphaned, pruned, totalSizeKB }. */
function gcScanRoot(
  root: string,
  liveWorktreeIds: Set<string>
): {
  totalDirs: number
  orphaned: number
  pruned: number
  totalSizeKB: number
  /** Every fish data dir a meta.json in this root names, for the orphan sweep. */
  fishHistoryDirs: Set<string>
} {
  const result = {
    totalDirs: 0,
    orphaned: 0,
    pruned: 0,
    totalSizeKB: 0,
    fishHistoryDirs: new Set<string>()
  }
  if (!existsSync(root)) {
    return result
  }

  const now = Date.now()

  for (const entry of readdirSync(root)) {
    // Why: pending-delete is a tombstone queue drained asynchronously, not a live worktree hash.
    if (entry === PENDING_DELETE_DIR_NAME) {
      continue
    }
    const entryPath = join(root, entry)
    try {
      const stat = statSync(entryPath)
      if (!stat.isDirectory()) {
        continue
      }
      result.totalDirs++

      // Estimate directory size from meta.json + history files.
      try {
        for (const file of readdirSync(entryPath)) {
          result.totalSizeKB += Math.ceil(statSync(join(entryPath, file)).size / 1024)
        }
      } catch {
        // Skip size estimation on error.
      }

      const metaPath = join(entryPath, 'meta.json')
      if (!existsSync(metaPath)) {
        // No meta.json — can't determine ownership, skip.
        continue
      }

      const meta = readHistoryMeta(entryPath)
      if (meta?.fishHistoryDir) {
        result.fishHistoryDirs.add(meta.fishHistoryDir)
      }
      if (!meta?.worktreeId) {
        continue
      }

      if (!liveWorktreeIds.has(meta.worktreeId)) {
        // Why: avoid a TOCTOU race where a worktree is created after the
        // live-ID snapshot but before GC runs. Directories younger than
        // GC_MIN_AGE_MS are presumed still live and skipped.
        if (meta.createdAt) {
          const ageMs = now - new Date(meta.createdAt).getTime()
          if (ageMs < GC_MIN_AGE_MS) {
            continue
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
  return result
}

/** Run background GC to prune history directories for worktrees that are no
 *  longer in Orca's known live-worktree set. */
export function runHistoryGc(liveWorktreeIds: Set<string>): void {
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
    const main = gcScanRoot(getHistoryRoot(), liveWorktreeIds)

    // Also scan WSL history directories (each distro has its own subdirectory).
    const wslTotals = { totalDirs: 0, orphaned: 0, pruned: 0, totalSizeKB: 0 }
    const liveFishHistoryDirs = new Set(main.fishHistoryDirs)
    for (const distroRoot of listWslHistoryRoots()) {
      schedulePendingHistoryTreeRemovals(distroRoot)
      const r = gcScanRoot(distroRoot, liveWorktreeIds)
      wslTotals.totalDirs += r.totalDirs
      wslTotals.orphaned += r.orphaned
      wslTotals.pruned += r.pruned
      wslTotals.totalSizeKB += r.totalSizeKB
      for (const dir of r.fishHistoryDirs) {
        liveFishHistoryDirs.add(dir)
      }
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
    const totalSizeKB = main.totalSizeKB + wslTotals.totalSizeKB

    console.log(
      `[pty:history:gc] totalDirs=${totalDirs} orphaned=${orphaned} pruned=${pruned} totalSizeKB=${totalSizeKB}`
    )
  } catch (err) {
    console.warn(`[pty:history:gc] GC failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Schedule GC after a delay so it runs after workspace hydration completes.
 *  `getLiveWorktreeIds` should use already-known IDs, not probe repo paths. */
export function scheduleHistoryGc(getLiveWorktreeIds: () => Promise<Set<string>>): void {
  // Why: main-window services can reattach during reload/reactivation; one
  // pending/running disk GC is enough and avoids duplicate startup I/O.
  if (scheduledHistoryGcTimer !== null || historyGcRunning) {
    return
  }
  // Why 10s: avoids competing with startup-critical I/O while still running
  // early enough to clean up before the user notices disk usage (§7.6).
  scheduledHistoryGcTimer = setTimeout(async () => {
    scheduledHistoryGcTimer = null
    historyGcRunning = true
    try {
      const liveIds = await getLiveWorktreeIds()
      runHistoryGc(liveIds)
    } catch (err) {
      console.warn(
        `[pty:history:gc] Failed to enumerate live worktrees for GC: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      historyGcRunning = false
    }
  }, 10_000)
}
