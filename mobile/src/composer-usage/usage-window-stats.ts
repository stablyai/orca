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

export type UsageChartPoint = { at: number; value: number }

export type UsageChartSegment = {
  from: UsageChartPoint
  to: UsageChartPoint
}

export type UsageChartModel = {
  /** The x-axis: the whole window, last reset to next reset, however little history there is. */
  startsAt: number
  endsAt: number
  /** Observed runs inside the window, oldest first. */
  runs: UsageChartPoint[][]
  /** Linearly extrapolated segments bridging missing data (reset→first, gaps, last→now, or reset→now with no samples). */
  extrapolated: UsageChartSegment[]
  /** Live point at `now`, clamped within the window. */
  current: UsageChartPoint
  /** The first stored reading in this window, or null when no readings are recorded yet. */
  firstAt: number | null
  /** The last stored reading in this window, or null when no readings are recorded yet. */
  lastRecordedAt: number | null
  /** The even-burn line's values at `startsAt` and `endsAt`; null without a reset time. */
  pace: { from: number; to: number } | null
  now: number
}

// The desktop polls every 15 minutes; a missed poll or two is not a gap.
const MIN_GAP_MS = 45 * 60_000
// The store keeps about this many points per window, so its spacing grows with the window.
const STORED_POINTS_PER_WINDOW = 168

/** Longest spacing still drawn as one line: past it the desktop was not reading usage. */
export function usageChartGapMs(windowMs: number, points: readonly UsageChartPoint[]): number {
  const steps = points.slice(1).map((point, index) => point.at - (points[index]?.at ?? point.at))
  steps.sort((a, b) => a - b)
  const typical = steps[Math.floor(steps.length / 2)] ?? 0
  return Math.max(MIN_GAP_MS, (2.5 * windowMs) / STORED_POINTS_PER_WINDOW, 2.5 * typical)
}

/** The chart's domain, observed runs, and extrapolated bridges across missing data; null only without a valid window. */
export function buildUsageChartModel(
  window: UsagePaceWindow,
  samples: readonly UsageHistorySample[],
  now: number,
  display: 'used' | 'remaining'
): UsageChartModel | null {
  const windowMs = window.windowMinutes * 60_000
  if (windowMs <= 0) {
    return null
  }
  // Without a reset time the window is the span that ends now.
  const endsAt = window.resetsAt ?? now
  const startsAt = endsAt - windowMs
  const clampedNow = Math.min(Math.max(now, startsAt), endsAt)
  const shown = (used: number): number =>
    display === 'remaining' ? 100 - clampPercent(used) : clampPercent(used)
  const currentUsed = Number.isFinite(window.usedPercent) ? clampPercent(window.usedPercent) : 0
  const startPoint: UsageChartPoint = { at: startsAt, value: shown(0) }
  const current: UsageChartPoint = { at: clampedNow, value: shown(currentUsed) }
  const pace = window.resetsAt != null ? { from: shown(0), to: shown(100) } : null
  const points = samples
    .filter((sample) => sample.at >= startsAt && sample.at <= clampedNow)
    .map((sample) => ({ at: sample.at, value: shown(sample.usedPercent) }))
    .sort((a, b) => a.at - b.at)
  const first = points[0]
  const lastRecorded = points.at(-1)
  if (!first || !lastRecorded) {
    return {
      startsAt,
      endsAt,
      runs: [],
      extrapolated: clampedNow > startsAt ? [{ from: startPoint, to: current }] : [],
      current,
      firstAt: null,
      lastRecordedAt: null,
      pace,
      now: clampedNow
    }
  }
  const gapMs = usageChartGapMs(windowMs, points)
  const runs: UsageChartPoint[][] = []
  let run: UsageChartPoint[] = []
  for (const point of points) {
    const previous = run.at(-1)
    if (previous && point.at - previous.at > gapMs) {
      runs.push(run)
      run = []
    }
    run.push(point)
  }
  runs.push(run)
  const extrapolated: UsageChartSegment[] = []
  if (first.at > startsAt) {
    extrapolated.push({ from: startPoint, to: first })
  }
  for (let index = 0; index < runs.length - 1; index += 1) {
    const end = runs[index]?.at(-1)
    const next = runs[index + 1]?.[0]
    if (end && next) {
      extrapolated.push({ from: end, to: next })
    }
  }
  if (clampedNow > lastRecorded.at) {
    if (clampedNow - lastRecorded.at > gapMs) {
      extrapolated.push({ from: lastRecorded, to: current })
    } else {
      runs.at(-1)?.push(current)
    }
  }
  return {
    startsAt,
    endsAt,
    runs,
    extrapolated,
    current,
    firstAt: first.at,
    lastRecordedAt: lastRecorded.at,
    pace,
    now: clampedNow
  }
}
