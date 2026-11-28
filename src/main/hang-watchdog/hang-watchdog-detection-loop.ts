export type HangWatchdogDetectionLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  /** Earlier tier for beachballs that recover before `timeoutMs`; omit to detect hangs only. */
  stallMs?: number
  now: () => number
  onHangDetected: (unresponsiveMs: number) => void
  /** Returns false when the silence was the machine's (a suspend), which restarts the stall clock. */
  onStallDetected?: (unresponsiveMs: number) => boolean
  /** Heartbeats resumed after a detected stall or hang — the main thread was stalled, not deadlocked. */
  onHangResolved: (unresponsiveMs: number) => void
  /** Heartbeats resumed after a stall no tick saw; its evidence can only be gathered afterwards. */
  onStallMissed?: (unresponsiveMs: number, startedAt: number) => void
  /** A sleep interrupted a detected stall; its silence after this point belongs to the machine. */
  onStallEndedBySleep?: (gapMs: number) => void
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
  // A heartbeat received while the tick was overdue came after the wake; the overdue tick keeps it.
  let wokeHeartbeat = false
  return {
    recordHeartbeat: () => {
      const now = config.now()
      const silentMs = now - lastHeartbeatAt
      if (detected === 'stall' && now - lastTickAt > sleepGapMs) {
        // Woke before the overdue tick: report and consume its gap first, in the tick's order, so it attaches to this stall.
        const tickGap = now - lastTickAt
        if (tickGap > config.timeoutMs) {
          config.onWatchdogGap?.(tickGap, lastTickAt)
        }
        lastTickAt = now
        detected = null
        config.onStallEndedBySleep?.(tickGap)
      } else if (detected) {
        detected = null
        config.onHangResolved(silentMs)
      } else if (stallMs !== null && silentMs > stallMs && now - lastTickAt <= sleepGapMs) {
        // A tick-gap reset already moved lastHeartbeatAt past any sleep, so this silence was main's.
        config.onStallMissed?.(silentMs, lastHeartbeatAt)
      }
      wokeHeartbeat ||= now - lastTickAt > sleepGapMs
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
          config.onStallEndedBySleep?.(tickGap)
        }
        // A wake heartbeat older than a sleep gap predates another sleep; it no longer marks main's start.
        if (!detected && !(wokeHeartbeat && now - lastHeartbeatAt <= sleepGapMs)) {
          lastHeartbeatAt = now
        }
        wokeHeartbeat = false
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
        if (config.onStallDetected?.(unresponsiveMs) === false) {
          detected = null
          lastHeartbeatAt = now
        }
      }
    }
  }
}
