import { logStartupDiagnostic } from './startup-diagnostics'

const TICK_MS = 25
const REPORT_EVERY_MS = 2_000
const STOP_AFTER_MS = 60_000

/**
 * Why: synchronous main-process work (execFileSync, blocking fs) is invisible
 * in milestone timestamps unless a milestone happens to straddle it. A timer
 * that should fire every 25ms fires late by exactly the blocked duration, so
 * the max observed gap is a direct measurement of the worst main-thread stall
 * in each window. Only runs under ORCA_STARTUP_DIAGNOSTICS, stops after 60s.
 */
export function startEventLoopStallProbe(): void {
  let last = performance.now()
  const started = last
  let lastReport = last
  let windowMaxGapMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const gap = now - last - TICK_MS
    last = now
    if (gap > windowMaxGapMs) {
      windowMaxGapMs = gap
    }
    if (now - lastReport >= REPORT_EVERY_MS) {
      logStartupDiagnostic('event-loop-stall', {
        t: Math.round(now),
        maxGapMs: Math.max(0, Math.round(windowMaxGapMs))
      })
      windowMaxGapMs = 0
      lastReport = now
    }
    if (now - started >= STOP_AFTER_MS) {
      clearInterval(timer)
    }
  }, TICK_MS)
  timer.unref?.()
}
