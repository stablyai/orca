import type { WorktreePollerWindowVisibility } from '../creation/worktree-base-directory-poller'

/** Holds focus, activity and reveal scans to the old 30 s cadence; inert without an interval. */
export type OnDemandScanGate = {
  scanStarted: (timedOrForced: boolean) => void
  scannedRecently: () => boolean
  /** The old tick parked when it landed inside a hide and forced a sweep on reveal; mirror exactly that. */
  hideSpannedOldTick: () => boolean
  clearHide: () => void
  /** A check that lands too soon runs once the throttle opens, so the last activity always gets one. */
  retryWhenOpen: (run: () => void) => void
  dispose: () => void
}

export function createOnDemandScanGate(
  minIntervalMs: number | undefined,
  visibility: WorktreePollerWindowVisibility
): OnDemandScanGate {
  let lastScanStartedAt = performance.now()
  // Where the old 30 s tick would fall: start-to-start from the last timed or forced scan (pokes never moved it).
  let oldCadenceAnchor = lastScanStartedAt
  let hiddenAt: number | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const unsubscribeHidden =
    minIntervalMs === undefined
      ? undefined
      : visibility.onWindowHidden?.(() => {
          hiddenAt ??= performance.now()
        })
  return {
    scanStarted: (timedOrForced) => {
      hiddenAt = null
      lastScanStartedAt = performance.now()
      if (timedOrForced) {
        oldCadenceAnchor = lastScanStartedAt
      }
    },
    scannedRecently: () =>
      minIntervalMs !== undefined && performance.now() - lastScanStartedAt < minIntervalMs,
    hideSpannedOldTick: () => {
      if (minIntervalMs === undefined || hiddenAt === null) {
        return false
      }
      const oldTickIndex = (time: number): number =>
        Math.floor((time - oldCadenceAnchor) / minIntervalMs)
      return oldTickIndex(performance.now()) > oldTickIndex(hiddenAt)
    },
    clearHide: () => {
      hiddenAt = null
    },
    retryWhenOpen: (run) => {
      if (minIntervalMs === undefined || retry) {
        return
      }
      const delay = Math.max(0, lastScanStartedAt + minIntervalMs - performance.now())
      retry = setTimeout(() => {
        retry = null
        run()
      }, delay)
      retry.unref?.()
    },
    dispose: () => {
      if (retry) {
        clearTimeout(retry)
      }
      unsubscribeHidden?.()
    }
  }
}
