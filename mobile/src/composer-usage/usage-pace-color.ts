import { usageBandColor } from '../accounts/usage/UsageBar'
import type { MobilePalette } from '../theme/mobile-theme'
import { usageExpectedPercent, type UsagePace, type UsagePaceWindow } from './usage-window-pace'

/** How a window is burning against an even pace; `over` would hit the limit before it resets. */
export type UsagePaceTone = 'under' | 'on-pace' | 'ahead' | 'over' | 'unpaced'

/** The pace line's reading: ahead turns `over` once the burn would run out before reset. */
export function usagePaceTone(pace: UsagePace): UsagePaceTone {
  switch (pace.kind) {
    case 'unknown':
      return 'unpaced'
    case 'exhausted':
      return 'over'
    case 'on-pace':
      return 'on-pace'
    case 'under':
      return 'under'
    case 'ahead':
      return pace.runOutBeforeResetMs === null ? 'ahead' : 'over'
  }
}

/**
 * The one colour for a usage window, shared by the composer bar and the usage
 * pop-up's pace line: green while on or under pace, amber ahead of it, red when the limit would be
 * reached before reset (or is). Without a pace (no reset time) it falls back to the used-level band.
 */
export function usagePaceColor(
  pace: UsagePace,
  usedPercent: number | null,
  colors: MobilePalette
): string {
  switch (usagePaceTone(pace)) {
    case 'under':
    case 'on-pace':
      return colors.statusGreen
    case 'ahead':
      return colors.statusAmber
    case 'over':
      return colors.statusRed
    case 'unpaced':
      return usageBandColor(usedPercent, colors)
  }
}

export type UsagePaceColorBand = 'green' | 'yellow' | 'red'

export type UsagePaceColorThresholds = {
  /** Max percentage points over even pace that still reads green (inclusive). */
  greenMaxOverPacePct: number
  /** Max percentage points over even pace that still reads yellow (inclusive); above is red. */
  yellowMaxOverPacePct: number
}

export const DEFAULT_USAGE_PACE_COLOR_THRESHOLDS: UsagePaceColorThresholds = {
  greenMaxOverPacePct: 5,
  yellowMaxOverPacePct: 10
}

export const USAGE_PACE_THRESHOLD_MIN = 0
export const USAGE_PACE_THRESHOLD_MAX = 50

// Absorbs IEEE-754 subtraction drift (e.g. 20.1 - 15.1 = 5.000000000000002) at exact boundaries.
const BOUNDARY_EPSILON = 1e-9

function clampThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(USAGE_PACE_THRESHOLD_MAX, Math.max(USAGE_PACE_THRESHOLD_MIN, value))
}

export function normalizeUsagePaceColorThresholds(
  input?: Partial<UsagePaceColorThresholds> | null
): UsagePaceColorThresholds {
  const greenMaxOverPacePct = clampThreshold(
    input?.greenMaxOverPacePct,
    DEFAULT_USAGE_PACE_COLOR_THRESHOLDS.greenMaxOverPacePct
  )
  const yellowCandidate = clampThreshold(
    input?.yellowMaxOverPacePct,
    DEFAULT_USAGE_PACE_COLOR_THRESHOLDS.yellowMaxOverPacePct
  )
  return {
    greenMaxOverPacePct,
    yellowMaxOverPacePct: Math.max(greenMaxOverPacePct, yellowCandidate)
  }
}

export function updateGreenPaceThreshold(
  current: UsagePaceColorThresholds,
  nextGreen: number
): UsagePaceColorThresholds {
  const greenMaxOverPacePct = clampThreshold(nextGreen, current.greenMaxOverPacePct)
  return {
    greenMaxOverPacePct,
    yellowMaxOverPacePct: Math.max(current.yellowMaxOverPacePct, greenMaxOverPacePct)
  }
}

export function updateYellowPaceThreshold(
  current: UsagePaceColorThresholds,
  nextYellow: number
): UsagePaceColorThresholds {
  const yellowMaxOverPacePct = clampThreshold(nextYellow, current.yellowMaxOverPacePct)
  return {
    greenMaxOverPacePct: Math.min(current.greenMaxOverPacePct, yellowMaxOverPacePct),
    yellowMaxOverPacePct
  }
}

export function parseUsagePaceColorThresholds(
  raw: string | null | undefined
): UsagePaceColorThresholds {
  if (!raw) {
    return DEFAULT_USAGE_PACE_COLOR_THRESHOLDS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_USAGE_PACE_COLOR_THRESHOLDS
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_USAGE_PACE_COLOR_THRESHOLDS
  }
  const green = 'greenMaxOverPacePct' in parsed ? parsed.greenMaxOverPacePct : undefined
  const yellow = 'yellowMaxOverPacePct' in parsed ? parsed.yellowMaxOverPacePct : undefined
  return normalizeUsagePaceColorThresholds({
    greenMaxOverPacePct: typeof green === 'number' ? Math.round(green) : undefined,
    yellowMaxOverPacePct: typeof yellow === 'number' ? Math.round(yellow) : undefined
  })
}

export function serializeUsagePaceColorThresholds(thresholds: UsagePaceColorThresholds): string {
  const normalized = normalizeUsagePaceColorThresholds({
    greenMaxOverPacePct: Math.round(thresholds.greenMaxOverPacePct),
    yellowMaxOverPacePct: Math.round(thresholds.yellowMaxOverPacePct)
  })
  return JSON.stringify(normalized)
}

export function isDefaultUsagePaceColorThresholds(thresholds: UsagePaceColorThresholds): boolean {
  return (
    thresholds.greenMaxOverPacePct === DEFAULT_USAGE_PACE_COLOR_THRESHOLDS.greenMaxOverPacePct &&
    thresholds.yellowMaxOverPacePct === DEFAULT_USAGE_PACE_COLOR_THRESHOLDS.yellowMaxOverPacePct
  )
}

/**
 * How far usage is over even pace. Green through the green threshold, yellow through the yellow
 * one, red past that. Null when either percent is missing.
 */
export function usagePaceColorBand(
  usedPercent: number | null,
  expectedPercent: number | null,
  thresholds?: Partial<UsagePaceColorThresholds> | null
): UsagePaceColorBand | null {
  if (
    usedPercent == null ||
    !Number.isFinite(usedPercent) ||
    expectedPercent == null ||
    !Number.isFinite(expectedPercent)
  ) {
    return null
  }
  const { greenMaxOverPacePct, yellowMaxOverPacePct } =
    normalizeUsagePaceColorThresholds(thresholds)
  const delta = usedPercent - expectedPercent
  if (delta <= greenMaxOverPacePct + BOUNDARY_EPSILON) {
    return 'green'
  }
  if (delta <= yellowMaxOverPacePct + BOUNDARY_EPSILON) {
    return 'yellow'
  }
  return 'red'
}

/** Pace color for a live window. A full window stays red. Without a pace, the used-level band. */
export function usageWindowPaceColor(
  window: UsagePaceWindow,
  now: number,
  thresholds: Partial<UsagePaceColorThresholds> | null | undefined,
  colors: MobilePalette
): string {
  const used = Number.isFinite(window.usedPercent)
    ? Math.max(0, Math.min(100, window.usedPercent))
    : null
  const expected = usageExpectedPercent(window, now)
  if (used !== null && expected !== null && used >= 100) {
    return colors.statusRed
  }
  switch (usagePaceColorBand(used, expected, thresholds)) {
    case 'green':
      return colors.statusGreen
    case 'yellow':
      return colors.statusAmber
    case 'red':
      return colors.statusRed
    case null:
      return usageBandColor(used, colors)
  }
}
