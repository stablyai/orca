import { startSpan } from '../observability/tracer'

// Why: a timer that fires N ms late proves the main thread was blocked for N ms.
// Always-on counterpart to main-thread-churn-probe, which is env-gated and stderr-only.
const TICK_MS = 1_000

// Why: coarse on purpose — it trades most sub-second jank for negligible idle
// wakeups (#7983 was an idle-churn regression). Multi-second beachballs still land.
const STALL_THRESHOLD_MS = 1_000

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Emit a `main-thread.stall` span whenever the main thread blocks for >=1s.
 *
 * No-op while the observability sink is unset — `startSpan` returns `noopSpan`
 * once the consent gates in `observability/index.ts` decline, so this needs no
 * gate of its own.
 *
 * Attribution is deliberately left out of the span: the `git.exec` spans that
 * overlap the stall window are already in the same trace file, timestamped.
 */
export function startMainThreadStallDetector(): void {
  if (timer) {
    return
  }
  let last = performance.now()
  timer = setInterval(() => {
    const now = performance.now()
    const gapMs = now - last - TICK_MS
    last = now
    if (gapMs < STALL_THRESHOLD_MS) {
      return
    }
    startSpan('main-thread.stall', {
      attributes: { gapMs: Math.round(gapMs), tickMs: TICK_MS }
    }).end()
  }, TICK_MS)
  timer.unref?.()
}

export function stopMainThreadStallDetector(): void {
  if (!timer) {
    return
  }
  clearInterval(timer)
  timer = null
}
