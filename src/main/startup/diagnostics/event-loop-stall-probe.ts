import { createEventLoopStallSummary } from '../../diagnostics/event-loop-delay-probe'
import { logStartupDiagnostic } from './startup-diagnostics'

const TICK_MS = 25
const REPORT_EVERY_MS = 2_000
const STOP_AFTER_MS = 60_000

/** Under startup diagnostics, timer drift exposes synchronous stalls that milestone timestamps miss; stop after 60s. */
export function startEventLoopStallProbe(): void {
  const started = performance.now()
  const summary = createEventLoopStallSummary(
    started,
    { tickMs: TICK_MS, windowMs: REPORT_EVERY_MS, reportableMaxGapMs: 0 },
    (window, now) =>
      logStartupDiagnostic('event-loop-stall', {
        t: Math.round(now),
        maxGapMs: window.maxGapMs
      })
  )
  const timer = setInterval(() => {
    const now = performance.now()
    summary.tick(now)
    if (now - started >= STOP_AFTER_MS) {
      clearInterval(timer)
    }
  }, TICK_MS)
  timer.unref?.()
}
