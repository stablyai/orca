import type {
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

const UNCHANGED_POLLS_BEFORE_IDLE = 3
/**
 * Consecutive forced retries that never resolved before the retry itself backs off to the idle
 * interval. A tree that stays unreadable (dead NFS/SMB mount, root-owned dir, Windows ACL/AV lock)
 * would otherwise hold the active cadence for the process lifetime, since a degraded scan can
 * never refresh the index backstop that keeps forcing it.
 */
const UNRESOLVED_FORCED_SCANS_BEFORE_IDLE = 3

export type GitCommonPollingCadence = {
  activeIntervalMs: number
  idleIntervalMs: number
  indexBackstopIntervalMs?: number
}

export type GitCommonPollResult = {
  changed: boolean
  /**
   * A leaf read failed and its previous value was retained, so this tick saw only part of the
   * tree. The observed half is still authoritative (no fabricated events); the unseen half is not.
   */
  degraded?: boolean
}

export type AdaptiveGitCommonPollSubscription = WorktreeBaseSubscription & {
  resetCadence: () => void
}

export async function tryTakeGitCommonPollBaseline<T>(
  takeSnapshot: () => Promise<T>,
  label: string
): Promise<T | null> {
  try {
    return await takeSnapshot()
  } catch (error) {
    // The first successful poll re-baselines, so this is recoverable — but a non-transient cause
    // (EACCES, corrupt git dir) would otherwise leave no trace of why startup re-emitted everything.
    console.warn(`[worktree-base-watcher] git-common poll baseline failed for ${label}:`, error)
    return null
  }
}

/**
 * Degraded scans a poller waits out before accepting a partial view as its baseline. Holding out
 * for a whole scan keeps a transient failure from seeding holes the next clean tick reports as
 * creates, but a chronically unreadable leaf (dead mount, TCC-protected path) would otherwise keep
 * the poller silent for the process lifetime — far worse than the one redundant create a partial
 * baseline costs when the leaf heals.
 */
const DEGRADED_BASELINE_SCANS_BEFORE_ACCEPT = 3

/** Returns true while the caller should keep waiting for a clean scan before baselining. */
export function createDegradedBaselineGate(): (degraded: boolean) => boolean {
  let degradedScans = 0
  return (degraded) => {
    if (!degraded) {
      return false
    }
    degradedScans++
    return degradedScans <= DEGRADED_BASELINE_SCANS_BEFORE_ACCEPT
  }
}

export function startAdaptiveGitCommonPoller(args: {
  cadence: GitCommonPollingCadence
  visibility: WorktreePollerWindowVisibility
  poll: (forceFullScan: boolean) => Promise<GitCommonPollResult>
}): AdaptiveGitCommonPollSubscription {
  const { cadence, visibility, poll } = args
  let disposed = false
  let ticking = false
  let unchangedPolls = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextPollAt = Number.POSITIVE_INFINITY
  let pendingForceFullScan = false
  let forceRetryNeeded = false
  let unresolvedForcedScans = 0
  let lastActivityAt: number | null = null
  // Why: one accelerated wake, refunded only when a poll observes a change or the window is
  // re-shown — there is no time-based refill. A chatty linked-worktree tree (index locks,
  // agent/status writers) fires native events many times a second while the polled files never
  // move; re-arming on every event both pins the active cadence forever and, since each arm
  // restarts the interval from now, can postpone the poll indefinitely. Activity that actually
  // predicts a change earns the next wake back.
  let activityWakeSpent = false
  let pendingActivityWake = false
  let indexBackstopAt =
    cadence.indexBackstopIntervalMs === undefined
      ? Number.POSITIVE_INFINITY
      : performance.now() + cadence.indexBackstopIntervalMs

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    nextPollAt = Number.POSITIVE_INFINITY
  }

  const armTimer = (delayMs: number): void => {
    clearTimer()
    nextPollAt = performance.now() + delayMs
    timer = setTimeout(() => {
      timer = null
      nextPollAt = Number.POSITIVE_INFINITY
      void tick()
    }, delayMs)
    timer.unref?.()
  }

  const resetCadence = (): void => {
    if (disposed) {
      return
    }
    lastActivityAt = performance.now()
    if (activityWakeSpent) {
      return
    }
    activityWakeSpent = true
    if (ticking) {
      pendingActivityWake = true
      return
    }
    if (!visibility.isWindowVisible()) {
      return
    }
    // Only ever pulls the next poll in, never pushes it out.
    armTimer(Math.min(cadence.activeIntervalMs, Math.max(0, nextPollAt - lastActivityAt)))
  }

  const tick = async (): Promise<void> => {
    clearTimer()
    if (disposed || !visibility.isWindowVisible() || ticking) {
      return
    }
    ticking = true
    pendingActivityWake = false
    const startedAt = performance.now()
    const requestedForceFullScan = pendingForceFullScan
    pendingForceFullScan = false
    const backstopDue = startedAt >= indexBackstopAt
    const shouldForceFullScan = requestedForceFullScan || forceRetryNeeded || backstopDue
    let succeeded = false
    let changed = false
    let degraded = false
    try {
      const result = await poll(shouldForceFullScan)
      succeeded = true
      changed = result.changed
      degraded = result.degraded === true
      // A degraded scan never read the whole tree, so it cannot satisfy the backstop.
      if (shouldForceFullScan && !degraded && cadence.indexBackstopIntervalMs !== undefined) {
        indexBackstopAt = performance.now() + cadence.indexBackstopIntervalMs
      }
      forceRetryNeeded = degraded && shouldForceFullScan
    } catch {
      // A thrown poll read nothing it can vouch for, so force the retry regardless of what this
      // tick was: a plain retry would re-gate the per-entry `index` read on an unchanged dir
      // signature and push detection out to the index backstop instead of the active interval.
      forceRetryNeeded = true
    } finally {
      ticking = false
    }
    if (disposed) {
      return
    }

    unchangedPolls = !succeeded || changed ? 0 : unchangedPolls + 1
    if (changed) {
      activityWakeSpent = false
    }
    if (pendingForceFullScan) {
      void tick()
      return
    }
    if (!visibility.isWindowVisible()) {
      return
    }
    if (forceRetryNeeded) {
      // A tick that still observed changes resolved something, so it does not count toward the
      // bound: one unreadable leaf must not drag a repo the user is actively moving to the idle
      // interval.
      unresolvedForcedScans = changed ? 0 : unresolvedForcedScans + 1
      // The early return is load-bearing: a degraded scan never advances indexBackstopAt, so the
      // tail clamp below would compute a 0ms delay and busy-loop. Keep forcing the scan — the
      // retry is what heals a transient failure — but stop paying the active cadence for a tree
      // that has stayed unreadable across several of them.
      armTimer(
        unresolvedForcedScans >= UNRESOLVED_FORCED_SCANS_BEFORE_IDLE
          ? cadence.idleIntervalMs
          : cadence.activeIntervalMs
      )
      return
    }
    unresolvedForcedScans = 0
    const now = performance.now()
    const intervalMs =
      unchangedPolls >= UNCHANGED_POLLS_BEFORE_IDLE
        ? cadence.idleIntervalMs
        : cadence.activeIntervalMs
    let delayMs = Math.max(0, intervalMs - (now - startedAt))
    if (pendingActivityWake && lastActivityAt !== null) {
      delayMs = Math.min(delayMs, Math.max(0, cadence.activeIntervalMs - (now - lastActivityAt)))
    }
    pendingActivityWake = false
    armTimer(Math.min(delayMs, Math.max(0, indexBackstopAt - now)))
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed) {
      return
    }
    unchangedPolls = 0
    activityWakeSpent = false
    lastActivityAt = performance.now()
    pendingForceFullScan = true
    clearTimer()
    if (!ticking) {
      void tick()
    }
  })

  armTimer(cadence.activeIntervalMs)
  return {
    resetCadence,
    unsubscribe: async () => {
      disposed = true
      clearTimer()
      unsubscribeVisibility()
    }
  }
}
