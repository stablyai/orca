import type {
  WorktreeBasePollEvent,
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import type { WorktreePollingScanLimits } from './worktree-polling-scan-budget'
import {
  diffGitCommon,
  PRIMARY_CHECKOUT_METADATA_FILES,
  snapshotGitCommon
} from './worktree-git-common-snapshot'

export { PRIMARY_CHECKOUT_METADATA_FILES }

// Why: the entry-dir signature gate can miss same-granule index rewrites on
// coarse-mtime filesystems; a periodic ungated re-stat bounds that miss the
// same way the base poller's backstop rescan does.
const INDEX_BACKSTOP_TICKS = 15

export async function startGitCommonPolling(
  commonDirPath: string,
  onEvents: (events: WorktreeBasePollEvent[]) => void,
  pollIntervalMs: number,
  visibility: WorktreePollerWindowVisibility,
  onFullScan?: () => void,
  includePrimary = true,
  scanLimits: Partial<WorktreePollingScanLimits> = {}
): Promise<WorktreeBaseSubscription> {
  let disposed = false
  let ticking = false
  let tickCount = 0
  let snapshot = await snapshotGitCommon(
    commonDirPath,
    undefined,
    includePrimary,
    false,
    scanLimits
  )
  let timer: ReturnType<typeof setTimeout> | null = null
  let parkedWhileHidden = false

  const tick = async (forceFullScan = false): Promise<void> => {
    timer = null
    if (disposed) {
      return
    }
    if (!visibility.isWindowVisible()) {
      parkedWhileHidden = true
      return
    }
    if (ticking) {
      return
    }
    ticking = true
    // Why: measure from tick start so cadence is start-to-start, not gap-after-completion (which would
    // land each visible refresh a full scan-duration late every tick).
    const startedAt = Date.now()
    tickCount++
    const shouldForceFullScan = forceFullScan || tickCount % INDEX_BACKSTOP_TICKS === 0
    try {
      const next = await snapshotGitCommon(
        commonDirPath,
        snapshot,
        includePrimary,
        shouldForceFullScan,
        scanLimits
      )
      if (disposed) {
        return
      }
      if (next.didFullScan) {
        onFullScan?.()
      }
      const events = diffGitCommon(commonDirPath, snapshot, next)
      snapshot = next
      if (events.length > 0) {
        onEvents(events)
      }
    } catch {
      // Transient fs error: keep the previous snapshot and retry next tick.
    } finally {
      ticking = false
    }
    if (!disposed) {
      // Why: clamp to [0, pollIntervalMs]. Date.now() is not monotonic — a backward wall-clock jump (NTP) would
      // otherwise make elapsed negative and push the next tick out by the adjustment (suppressing refreshes for
      // minutes); the upper clamp caps the wait at one interval, the lower clamp keeps a long scan from going negative.
      const nextDelay = Math.max(
        0,
        Math.min(pollIntervalMs, pollIntervalMs - (Date.now() - startedAt))
      )
      timer = setTimeout(() => void tick(), nextDelay)
      timer.unref?.()
    }
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed || !parkedWhileHidden) {
      return
    }
    parkedWhileHidden = false
    // Why: a linked index can change without its parent dir signature moving;
    // force the leaf read when diffing the retained pre-hide snapshot.
    void tick(true)
  })

  timer = setTimeout(() => void tick(), pollIntervalMs)
  timer.unref?.()

  return {
    unsubscribe: async () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
      unsubscribeVisibility()
    }
  }
}
