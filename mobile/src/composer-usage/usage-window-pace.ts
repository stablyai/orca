export type UsagePaceWindow = {
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
}

export type UsagePace =
  | { kind: 'unknown' }
  | { kind: 'on-pace'; deltaPercent: number }
  | { kind: 'ahead'; deltaPercent: number; runOutBeforeResetMs: number | null }
  | { kind: 'under'; deltaPercent: number }

// Small drift either way reads as on pace; a few points is within one poll's noise.
export const ON_PACE_TOLERANCE_PERCENT = 3

/** Compare usage with an even burn across the window; ahead also projects the linear run-out. */
export function computeUsagePace(window: UsagePaceWindow, now: number): UsagePace {
  const windowMs = window.windowMinutes * 60_000
  if (window.resetsAt == null || windowMs <= 0) {
    return { kind: 'unknown' }
  }
  const remainingMs = window.resetsAt - now
  const elapsedMs = windowMs - remainingMs
  // A past reset is stale data and a not-yet-started window has no rate to compare.
  if (remainingMs <= 0 || elapsedMs <= 0) {
    return { kind: 'unknown' }
  }
  const used = Math.max(0, Math.min(100, window.usedPercent))
  const expected = Math.min(100, (elapsedMs / windowMs) * 100)
  const deltaPercent = Math.round(used - expected)
  if (Math.abs(used - expected) < ON_PACE_TOLERANCE_PERCENT) {
    return { kind: 'on-pace', deltaPercent }
  }
  if (used < expected) {
    return { kind: 'under', deltaPercent: -deltaPercent }
  }
  const msToFull = used > 0 ? ((100 - used) / used) * elapsedMs : Infinity
  const runOutBeforeResetMs = remainingMs - msToFull
  return {
    kind: 'ahead',
    deltaPercent,
    runOutBeforeResetMs: runOutBeforeResetMs > 0 ? runOutBeforeResetMs : null
  }
}
