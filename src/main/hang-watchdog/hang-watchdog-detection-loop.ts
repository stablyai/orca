export type HangWatchdogDetectionLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  now: () => number
  onHangDetected: (unresponsiveMs: number) => void
  /** Heartbeats resumed after a detected hang — the main thread was stalled, not deadlocked. */
  onHangResolved: (unresponsiveMs: number) => void
  onWatchdogGap?: (gapMs: number, startedAt: number) => void
}

export type HangWatchdogDetectionLoop = {
  recordHeartbeat: () => void
  tick: () => void
}

export function createHangWatchdogDetectionLoop(
  config: HangWatchdogDetectionLoopConfig
): HangWatchdogDetectionLoop {
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
      // Advance while hung so recovery cannot be misclassified as a long system-sleep gap.
      lastTickAt = now
      // Sleep, process suspension and observer starvation are indistinguishable here.
      if (tickGap > config.checkIntervalMs * 3) {
        if (tickGap > config.timeoutMs) {
          config.onWatchdogGap?.(tickGap, now - tickGap)
        }
        if (!detected) {
          lastHeartbeatAt = now
        }
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
