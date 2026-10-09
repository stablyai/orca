import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

// Why 20ms: the histogram is a libuv timer, so resolution is a standing cost paid for the whole
// life of a serve. A p99 that matters operationally is #19312's "new WebSocket connections hung
// 15s+", which 20ms resolves with room to spare; Node's 10ms default doubles the wakeups to
// sharpen a distinction nobody acts on.
const RESOLUTION_MS = 20
const NS_PER_MS = 1_000_000

let monitor: IntervalHistogram | null = null

/**
 * Starts the one process-wide event-loop-delay histogram. Idempotent, so a second serve surface
 * coming up cannot silently reset the window.
 */
export function enableServeStatsEventLoopDelayMonitor(): void {
  if (monitor) {
    return
  }
  monitor = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  monitor.enable()
}

/**
 * p99 event loop delay in milliseconds since the previous read, or null when unmeasured.
 *
 * Reset-on-read by design — see `RuntimeServeStatsHealth.eventLoopDelayP99Ms` for why a
 * lifetime-cumulative percentile stops being a signal. Null covers both "monitor never enabled"
 * and "enabled but no sample recorded yet"; neither may surface as 0, which would claim a
 * measured, healthy loop.
 */
export function readServeStatsEventLoopDelayP99Ms(): number | null {
  if (!monitor || monitor.count === 0) {
    return null
  }
  const delayNs = monitor.percentile(99)
  monitor.reset()
  return Number.isFinite(delayNs) ? Math.round((delayNs / NS_PER_MS) * 100) / 100 : null
}

/** Test seam: drops the histogram (and its timer) so a case can prove the unmeasured path. */
export function disableServeStatsEventLoopDelayMonitorForTest(): void {
  monitor?.disable()
  monitor = null
}
