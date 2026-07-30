export type HangWatchdogChildLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  now: () => number
  onHangDetected: (unresponsiveMs: number) => void
  /** Heartbeats resumed after a detected hang — the main thread was stalled, not deadlocked. */
  onHangResolved: (unresponsiveMs: number) => void
}

export type HangWatchdogChildLoop = {
  recordHeartbeat: () => void
  tick: () => void
}

export function createHangWatchdogChildLoop(
  config: HangWatchdogChildLoopConfig
): HangWatchdogChildLoop {
  let lastHeartbeatAt = config.now()
  let lastTickAt = config.now()
  let detected = false
  return {
    recordHeartbeat: () => {
      const now = config.now()
      if (detected) {
        detected = false
        config.onHangResolved(now - lastHeartbeatAt)
      }
      lastHeartbeatAt = now
    },
    tick: () => {
      const now = config.now()
      const tickGap = now - lastTickAt
      // Why: advance the tick clock even while a hang is outstanding, or the first tick after the
      // stall clears reads as a huge gap and gets misread as system sleep.
      lastTickAt = now
      if (detected) {
        return
      }
      // Why: system sleep suspends this process too; a huge tick gap means suspension, not a parent hang, so restart the wait from scratch.
      if (tickGap > config.checkIntervalMs * 3) {
        lastHeartbeatAt = now
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
