export type HangWatchdogDetectionLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  now: () => number
  onHangDetected: (unresponsiveMs: number) => void
  /** Heartbeats resumed after a detected hang — the main thread was stalled, not deadlocked. */
  onHangResolved: (unresponsiveMs: number) => void
  /** System suspend interrupted an open episode; duration excludes time spent asleep. */
  onHangSuspended?: (unresponsiveMs: number) => void
}

export type HangWatchdogDetectionLoop = {
  recordHeartbeat: () => void
  setSuspended: (suspended: boolean) => void
  tick: () => void
}

export function createHangWatchdogDetectionLoop(
  config: HangWatchdogDetectionLoopConfig
): HangWatchdogDetectionLoop {
  let lastHeartbeatAt = config.now()
  let lastTickAt = config.now()
  let detected = false
  let suspended = false
  return {
    recordHeartbeat: () => {
      const now = config.now()
      if (detected) {
        detected = false
        config.onHangResolved(now - lastHeartbeatAt)
      }
      lastHeartbeatAt = now
    },
    setSuspended: (next) => {
      const now = config.now()
      if (next && !suspended && detected) {
        // Close an open episode at the suspend edge. It must not be rewritten as a
        // self-recovered hang or accrue wall-clock duration while the host sleeps.
        config.onHangSuspended?.(Math.max(0, now - lastHeartbeatAt))
        detected = false
      }
      suspended = next
      // Reset both clocks on either edge so resume starts a fresh observation window.
      lastHeartbeatAt = now
      lastTickAt = now
    },
    tick: () => {
      const now = config.now()
      const tickGap = now - lastTickAt
      const previousTickAt = lastTickAt
      // Why: advance the tick clock even while a hang is outstanding, or the first tick after the
      // stall clears reads as a huge gap and gets misread as system sleep.
      lastTickAt = now
      if (suspended) {
        return
      }
      // Why: system sleep suspends this process too; a huge tick gap means suspension, not a parent hang, so restart the wait from scratch.
      if (tickGap > config.checkIntervalMs * 3) {
        if (detected) {
          config.onHangSuspended?.(Math.max(0, previousTickAt - lastHeartbeatAt))
          detected = false
        }
        lastHeartbeatAt = now
        return
      }
      if (detected) {
        return
      }
      const unresponsiveMs = now - lastHeartbeatAt
      if (unresponsiveMs > config.timeoutMs) {
        detected = true
        config.onHangDetected(unresponsiveMs)
      }
    }
  }
}
