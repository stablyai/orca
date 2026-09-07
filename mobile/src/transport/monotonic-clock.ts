// Why: connection phase durations must never go negative. Date.now() can jump
// backwards (NTP or a user clock change) mid-dial, which would turn a slow stage
// into a negative one in the diagnostics report. performance.now() is monotonic
// and Hermes exposes it; hosts without it fall back to wall clock.
const hasPerformanceNow =
  typeof performance === 'object' && performance !== null && typeof performance.now === 'function'

export const monotonicNowMs: () => number = hasPerformanceNow
  ? () => performance.now()
  : () => Date.now()

/** Whole milliseconds between two monotonic reads, clamped so a fallback wall-clock jump can't go negative. */
export function elapsedMs(startedAt: number, endedAt: number = monotonicNowMs()): number {
  return Math.max(0, Math.round(endedAt - startedAt))
}
