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
  /** A sleep interrupted a detected stall or hang; its silence after this point belongs to the machine. */
  onEpisodeEndedBySleep?: () => void
  onWatchdogGap?: (gapMs: number, startedAt: number) => void
}

export type HangWatchdogDetectionLoop = {
  recordHeartbeat: () => void
  /** Main relayed a suspend or resume, so it answered then; silence after a suspend is the machine's until main answers again. */
  recordPowerEvent: (event: 'suspend' | 'resume') => void
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
  // A sleep shorter than sleepGapMs leaves no tick gap, so after a suspend only main's next answer restarts the clock.
  let awaitingWake = false
  return {
    recordHeartbeat: () => {
      const now = config.now()
      const silentMs = now - lastHeartbeatAt
      if (detected && now - lastTickAt > sleepGapMs) {
        // Woke before the overdue tick: report and consume its gap first, in the tick's order, so it attaches to this stall.
        const tickGap = now - lastTickAt
        if (tickGap > config.timeoutMs) {
          config.onWatchdogGap?.(tickGap, lastTickAt)
        }
        lastTickAt = now
        detected = null
        config.onEpisodeEndedBySleep?.()
      } else if (detected) {
        detected = null
        config.onHangResolved(silentMs)
      } else if (
        !awaitingWake &&
        stallMs !== null &&
        silentMs > stallMs &&
        now - lastTickAt <= sleepGapMs
      ) {
        // A tick-gap reset already moved lastHeartbeatAt past any sleep, so this silence was main's.
        config.onStallMissed?.(silentMs, lastHeartbeatAt)
      }
      wokeHeartbeat ||= now - lastTickAt > sleepGapMs
      awaitingWake = false
      lastHeartbeatAt = now
    },
    recordPowerEvent: (event) => {
      if (detected) {
        detected = null
        config.onEpisodeEndedBySleep?.()
      }
      awaitingWake = event === 'suspend'
      lastHeartbeatAt = config.now()
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
        if (detected) {
          detected = null
          config.onEpisodeEndedBySleep?.()
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
      if (awaitingWake) {
        if (now - lastHeartbeatAt <= config.timeoutMs + sleepGapMs) {
          return
        }
        // Main never answered: count it unresponsive, less the longest sleep a tick cannot see.
        awaitingWake = false
        lastHeartbeatAt += sleepGapMs
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
