// Schedule triggers: the desktop's five-field cron dialect (shared parser) evaluated in an IANA time
// zone. Workers run in UTC, so wall-clock fields come from Intl instead of the process zone.
//
// DST, the same way a person reading the schedule expects it:
// - A wall time that does not exist (spring forward, e.g. 02:30) runs once, at the end of the gap.
// - A wall time that happens twice (fall back, e.g. 01:30) runs once, on its first pass. Rules that
//   run every hour keep following real time instead (vixie cron's rule), so hourly stays hourly.
import { isValidAutomationCronSchedule, parseCronExpression, type ParsedCron } from './shared-scheduling.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Feb 29 rules can skip eight years across a non-leap century (same bound as the desktop). */
const SCAN_MS = 9 * 366 * DAY
/** Cost guard: schedules may not fire more often than this (dev accounts are exempt). */
export const MIN_SCHEDULE_INTERVAL_MINUTES = 15

export class ScheduleError extends Error {
  constructor(readonly reason: 'invalid_cron' | 'invalid_timezone' | 'too_frequent') {
    super(reason)
    this.name = 'ScheduleError'
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatters.set(timeZone, format)
  }
  return format
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) {
    return false
  }
  try {
    formatter(timeZone)
    return true
  } catch {
    return false
  }
}

/** Wall clock minus UTC (ms) in `timeZone` at instant `t`. */
export function zoneOffset(timeZone: string, t: number): number {
  const parts = formatter(timeZone).formatToParts(new Date(t))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - Math.floor(t / 1000) * 1000
}

/** Validates a routine's schedule; returns the parsed rule. */
export function parseRoutineSchedule(cron: string, timeZone: string, options: { allowFrequent?: boolean } = {}): ParsedCron {
  if (cron.length > 256 || !isValidAutomationCronSchedule(cron)) {
    throw new ScheduleError('invalid_cron')
  }
  if (!isValidTimeZone(timeZone)) {
    throw new ScheduleError('invalid_timezone')
  }
  const rule = parseCronExpression(cron.trim(), { rejectOversizedStep: true })
  if (!options.allowFrequent && minIntervalMinutes(rule) < MIN_SCHEDULE_INTERVAL_MINUTES) {
    throw new ScheduleError('too_frequent')
  }
  return rule
}

/**
 * Smallest gap between two consecutive firings, in minutes (wall clock). Conservative: two allowed
 * hours in a row count as adjacent even when the day fields would separate them.
 */
export function minIntervalMinutes(rule: ParsedCron): number {
  const minutes = [...rule.minutes].sort((a, b) => a - b)
  let gap = Number.POSITIVE_INFINITY
  for (let i = 1; i < minutes.length; i++) {
    gap = Math.min(gap, minutes[i]! - minutes[i - 1]!)
  }
  const adjacentHours = [...rule.hours].some((hour) => rule.hours.has((hour + 1) % 24))
  if (adjacentHours && minutes.length > 0) {
    gap = Math.min(gap, 60 - minutes.at(-1)! + minutes[0]!)
  }
  return gap
}

function dateMatches(rule: ParsedCron, wall: Date): boolean {
  if (!rule.months.has(wall.getUTCMonth() + 1)) {
    return false
  }
  const dayOfMonth = rule.daysOfMonth.has(wall.getUTCDate())
  const dayOfWeek = rule.daysOfWeek.has(wall.getUTCDay())
  // Same dialect rule as the desktop: two restricted day fields match on either.
  return rule.dayOfMonthRestricted && rule.dayOfWeekRestricted ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek
}

/** First wall time in [fromWall, toWall) that matches, with whole-day and whole-hour skips. */
function firstWallMatch(rule: ParsedCron, fromWall: number, toWall: number): number | null {
  let wall = Math.ceil(fromWall / MINUTE) * MINUTE
  while (wall < toWall) {
    const d = new Date(wall)
    const [y, mo, day, h] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()]
    if (!dateMatches(rule, d)) {
      wall = Date.UTC(y, mo, day + 1)
      continue
    }
    if (!rule.hours.has(h)) {
      wall = Date.UTC(y, mo, day, h + 1)
      continue
    }
    const minute = d.getUTCMinutes()
    let next: number | undefined
    for (const candidate of rule.minutes) {
      if (candidate >= minute && (next === undefined || candidate < next)) {
        next = candidate
      }
    }
    if (next === undefined) {
      wall = Date.UTC(y, mo, day, h + 1)
      continue
    }
    wall = Date.UTC(y, mo, day, h, next)
    return wall < toWall ? wall : null
  }
  return null
}

/** First instant in (t, t + 1 day] whose offset differs from `offset`, else t + 1 day (minute precision). */
function segmentEnd(timeZone: string, t: number, offset: number, limit: number): number {
  const probe = Math.min(t + DAY, limit)
  if (zoneOffset(timeZone, probe) === offset) {
    return probe
  }
  let lo = t
  let hi = probe
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE
    if (zoneOffset(timeZone, mid) === offset) {
      lo = mid
    } else {
      hi = mid
    }
  }
  return hi
}

/** The first firing strictly after `after` (epoch ms), or null when the rule never fires again. */
export function nextRunAfter(rule: ParsedCron, timeZone: string, after: number): number | null {
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE
  const limit = t + SCAN_MS
  let skipWallBefore = Number.NEGATIVE_INFINITY
  // Starting inside the second pass of a fall-back hour: its wall times already fired once.
  const before = zoneOffset(timeZone, t - 3 * HOUR)
  const offsetNow = zoneOffset(timeZone, t)
  const everyHour = rule.hours.size === 24
  if (before > offsetNow && !everyHour) {
    skipWallBefore = segmentEnd(timeZone, t - 3 * HOUR, before, t) + before
  }
  while (t < limit) {
    const offset = zoneOffset(timeZone, t)
    const end = segmentEnd(timeZone, t, offset, limit)
    const hit = firstWallMatch(rule, Math.max(t + offset, skipWallBefore), end + offset)
    if (hit !== null) {
      return hit - offset
    }
    if (end >= limit) {
      break
    }
    const nextOffset = zoneOffset(timeZone, end)
    if (nextOffset > offset && firstWallMatch(rule, end + offset, end + nextOffset) !== null) {
      // Spring forward skipped a wall time the rule wanted: run as the gap ends.
      return end
    }
    if (nextOffset < offset && !everyHour) {
      // Fall back: wall times in [end + nextOffset, end + offset) come round again; fire once.
      skipWallBefore = end + offset
    }
    t = end
  }
  return null
}

/** The latest firing at or before `now`, scanning forward from `from` (exclusive). Null if none. */
export function latestRunAtOrBefore(rule: ParsedCron, timeZone: string, from: number, now: number, maxSteps = 10_000): number | null {
  let latest: number | null = null
  let cursor = from
  for (let i = 0; i < maxSteps; i++) {
    const next = nextRunAfter(rule, timeZone, cursor)
    if (next === null || next > now) {
      break
    }
    latest = next
    cursor = next
  }
  return latest
}
