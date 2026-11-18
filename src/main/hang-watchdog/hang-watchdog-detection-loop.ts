export type HangWatchdogDetectionLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  /** Earlier tier for beachballs that recover before `timeoutMs`; omit to detect hangs only. */
  stallMs?: number
  now: () => number
  onHangDetected: (unresponsiveMs: number) => void
  onStallDetected?: (unresponsiveMs: number) => void
  /** Heartbeats resumed after a detected stall or hang — the main thread was stalled, not deadlocked. */
  onHangResolved: (unresponsiveMs: number) => void
  /** Heartbeats resumed after a stall no tick saw; its evidence can only be gathered afterwards. */
  onStallMissed?: (unresponsiveMs: number, startedAt: number) => void
  /** A sleep interrupted a detected stall; its silence after this point belongs to the machine. */
  onStallEndedBySleep?: () => void
  onWatchdogGap?: (gapMs: number, startedAt: number) => void
}

export type HangWatchdogDetectionLoop = {
  recordHeartbeat: () => void
  tick: () => void
}

export function createHangWatchdogDetectionLoop(
  config: HangWatchdogDetectionLoopConfig
): HangWatchdogDetectionLoop {
  const sleepGapMs = config.checkIntervalMs * 3
  const stallMs =
    config.stallMs !== undefined && config.stallMs < config.timeoutMs ? config.stallMs : null
  let lastHeartbeatAt = config.now()
  let lastTickAt = config.now()
  let detected: 'stall' | 'hang' | null = null
  return {
    recordHeartbeat: () => {
      const now = config.now()
      const silentMs = now - lastHeartbeatAt
      if (detected) {
        detected = null
        config.onHangResolved(silentMs)
      } else if (stallMs !== null && silentMs > stallMs && now - lastTickAt <= sleepGapMs) {
        // A tick-gap reset already moved lastHeartbeatAt past any sleep, so this silence was main's.
        config.onStallMissed?.(silentMs, lastHeartbeatAt)
      }
      lastHeartbeatAt = now
    },
    tick: () => {
      const now = config.now()
      const tickGap = now - lastTickAt
      // Advance while hung so recovery cannot be misclassified as a long system-sleep gap.
      lastTickAt = now
      // Sleep, process suspension and observer starvation are indistinguishable here.
      if (tickGap > sleepGapMs) {
        if (tickGap > config.timeoutMs) {
          config.onWatchdogGap?.(tickGap, now - tickGap)
        }
        if (detected === 'stall') {
          detected = null
          config.onStallEndedBySleep?.()
        }
        if (!detected) {
          lastHeartbeatAt = now
        }
        return
      }
      if (detected === 'hang') {
        return
      }
      const unresponsiveMs = now - lastHeartbeatAt
      if (unresponsiveMs > config.timeoutMs) {
        detected = 'hang'
        config.onHangDetected(unresponsiveMs)
      } else if (!detected && stallMs !== null && unresponsiveMs > stallMs) {
        detected = 'stall'
        config.onStallDetected?.(unresponsiveMs)
      }
    }
  }
}
