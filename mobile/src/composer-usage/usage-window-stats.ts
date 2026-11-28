import type { UsageHistorySample } from '../../../src/shared/agent-usage/rate-limits/usage-window-history'
import type { UsagePaceWindow } from './usage-window-pace'

const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

export type UsageWindowStats = {
  /** Used minus an even burn's share so far, in points; negative is under pace. */
  paceDeltaPoints: number | null
  /** What is left spread evenly until reset, in percent per `budgetPeriodMs`. */
  budgetPercent: number | null
  /** A day, or an hour for windows of a day or less, where a daily budget means little. */
  budgetPeriodMs: number
  /** Used percent at reset if the window's average rate so far holds, capped at 100. */
  projectedAtReset: number | null
  /** How far back `recentPoints` looks: a day, or an hour for windows of a day or less. */
  recentLookbackMs: number
  /** Points used over `recentLookbackMs`; null when history does not reach back that far. */
  recentPoints: number | null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** Where the window sits now; null when its reset is unknown or the reading is stale. */
function windowTiming(window: UsagePaceWindow, now: number) {
  const windowMs = window.windowMinutes * 60_000
  if (window.resetsAt == null || windowMs <= 0) {
    return null
  }
  const remainingMs = window.resetsAt - now
  const elapsedMs = windowMs - remainingMs
  if (remainingMs <= 0 || elapsedMs <= 0) {
    return null
  }
  return { windowMs, remainingMs, elapsedMs, startsAt: window.resetsAt - windowMs }
}

/** Points used since `cutoff`: a window that began after it counts all its usage. */
function usedSince(
  samples: readonly UsageHistorySample[],
  used: number,
  cutoff: number,
  startsAt: number | null
): number | null {
  if (startsAt !== null && startsAt >= cutoff) {
    return used
  }
  let before: UsageHistorySample | null = null
  for (const sample of samples) {
    if (sample.at > cutoff) {
      break
    }
    before = sample
  }
  return before ? Math.max(0, used - clampPercent(before.usedPercent)) : null
}

export function computeUsageWindowStats(
  window: UsagePaceWindow,
  samples: readonly UsageHistorySample[],
  now: number
): UsageWindowStats {
  const used = clampPercent(window.usedPercent)
  const recentLookbackMs = window.windowMinutes * 60_000 > DAY_MS ? DAY_MS : HOUR_MS
  const budgetPeriodMs = recentLookbackMs
  const timing = windowTiming(window, now)
  const recentPoints = usedSince(samples, used, now - recentLookbackMs, timing?.startsAt ?? null)
  if (!timing) {
    return {
      paceDeltaPoints: null,
      budgetPercent: null,
      budgetPeriodMs,
      projectedAtReset: null,
      recentLookbackMs,
      recentPoints
    }
  }
  const expected = (timing.elapsedMs / timing.windowMs) * 100
  return {
    paceDeltaPoints: used - expected,
    budgetPercent: (100 - used) / (timing.remainingMs / budgetPeriodMs),
    budgetPeriodMs,
    projectedAtReset: clampPercent(used + (used / timing.elapsedMs) * timing.remainingMs),
    recentLookbackMs,
    recentPoints
  }
}

export type UsageChartModel = {
  /** The x-axis: the recorded history, at least six hours, ending now. */
  startsAt: number
  endsAt: number
  /** Samples inside the window, oldest first, values as the display counts them. */
  points: { at: number; value: number }[]
  /** The even-burn line's values at `startsAt` and `endsAt`; null without a reset time. */
  pace: { from: number; to: number } | null
  now: number
}

// Two readings make a line; a lone point says nothing about the trend.
export const MIN_CHART_SAMPLES = 2
// Two close readings stretched edge to edge would exaggerate a small step.
const MIN_CHART_SPAN_MS = 6 * HOUR_MS

/** The chart's domain and series, or null while history is too thin to draw. Spanning the whole
 *  window left a few hours of history as a sliver beside an empty future, so the axis zooms to
 *  the history (never less than six hours, or the window when shorter) and ends at now. */
export function buildUsageChartModel(
  window: UsagePaceWindow,
  samples: readonly UsageHistorySample[],
  now: number,
  display: 'used' | 'remaining'
): UsageChartModel | null {
  const windowMs = window.windowMinutes * 60_000
  const windowStart = window.resetsAt != null ? window.resetsAt - windowMs : null
  const shown = (used: number): number =>
    display === 'remaining' ? 100 - clampPercent(used) : clampPercent(used)
  const points = samples
    .filter((sample) => (windowStart === null || sample.at >= windowStart) && sample.at <= now)
    .map((sample) => ({ at: sample.at, value: shown(sample.usedPercent) }))
  const first = points[0]
  if (points.length < MIN_CHART_SAMPLES || !first) {
    return null
  }
  const minSpanMs = windowMs > 0 ? Math.min(windowMs, MIN_CHART_SPAN_MS) : MIN_CHART_SPAN_MS
  const startsAt = Math.max(windowStart ?? first.at, Math.min(first.at, now - minSpanMs))
  const endsAt = now
  if (endsAt <= startsAt) {
    return null
  }
  const evenBurn = (at: number): number =>
    windowStart === null ? 0 : shown(((at - windowStart) / windowMs) * 100)
  return {
    startsAt,
    endsAt,
    points,
    pace: windowStart !== null ? { from: evenBurn(startsAt), to: evenBurn(endsAt) } : null,
    now
  }
}
