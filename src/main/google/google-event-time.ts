// The times and lengths `orca calendar create|update|suggest-time` take: a day, a time with its
// offset, or a bare local time in the event's zone; lengths like 30m, 1h or 1h30m.
import { GoogleToolError } from './google-api-client'
import { addDays, zonedInstant } from './google-time-zone'
import { hasImpossibleLeadingDate } from '../../shared/validation/calendar-date'

/** An event's length when only its start is given. */
export const DEFAULT_EVENT_MINUTES = 30

export type EventTime = { kind: 'day'; date: string } | { kind: 'time'; ms: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i

export function parseEventTime(value: string, timeZone: string, flag: string): EventTime {
  const trimmed = value.trim()
  if (hasImpossibleLeadingDate(trimmed)) {
    throw new GoogleToolError(
      `${flag} takes a real calendar date; ${trimmed.slice(0, 10)} is not one.`
    )
  }
  if (DAY.test(trimmed)) {
    return { kind: 'day', date: trimmed }
  }
  const local = LOCAL.exec(trimmed)
  if (local?.[1] && local[2]) {
    // Why: a clock like 25:00 would otherwise reach Intl in zonedInstant and throw a RangeError.
    if (Number.isNaN(Date.parse(`${local[1]}T${local[2]}:00Z`))) {
      throw new GoogleToolError(`${flag} takes a real clock time; ${local[2]} is not one.`)
    }
    return { kind: 'time', ms: zonedInstant(local[1], local[2], timeZone) }
  }
  if (WITH_OFFSET.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) {
    return { kind: 'time', ms: Date.parse(trimmed) }
  }
  throw new GoogleToolError(
    `${flag} takes a time (2026-11-04T10:00 in the calendar's zone, or with an offset like 2026-11-04T10:00-05:00) or, for all-day, a day (2026-11-04).`
  )
}

/** Minutes in "30m", "1h", "1h30m", "90" (minutes). */
export function parseDuration(value: string): number {
  const match = /^(?:(\d+)h)?\s*(?:(\d+)m?)?$/i.exec(value.trim())
  const minutes = Number(match?.[1] ?? 0) * 60 + Number(match?.[2] ?? 0)
  if (!match || minutes <= 0 || minutes > 24 * 60) {
    throw new GoogleToolError('--duration takes a length like 30m, 1h or 1h30m.')
  }
  return minutes
}

/** An IANA zone (America/New_York) Intl knows, or undefined when none was given. */
export function validTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone
  } catch {
    throw new GoogleToolError(
      `"${value}" isn't a time zone; use an IANA name like America/New_York.`
    )
  }
}

/** Google's start and end for a time and a length or an end; all-day ends are days included. */
export function startAndEnd(
  start: EventTime,
  end: EventTime | null,
  minutes: number | null,
  timeZone: string
): { start: object; end: object } {
  if (start.kind === 'day') {
    if (minutes !== null) {
      throw new GoogleToolError('An all-day event takes --end <day>, not --duration.')
    }
    if (end && end.kind !== 'day') {
      throw new GoogleToolError('An all-day event ends on a day: --end 2026-11-06.')
    }
    const last = end?.date ?? start.date
    if (last < start.date) {
      throw new GoogleToolError('--end is before --start.')
    }
    // Google's all-day end is the day after the last one.
    return { start: { date: start.date }, end: { date: addDays(last, 1) } }
  }
  if (end?.kind === 'day') {
    throw new GoogleToolError('Give --end as a time too, or use --duration.')
  }
  const endMs = end ? end.ms : start.ms + (minutes ?? DEFAULT_EVENT_MINUTES) * 60_000
  if (endMs <= start.ms) {
    throw new GoogleToolError('--end is before --start.')
  }
  return {
    start: { dateTime: new Date(start.ms).toISOString(), timeZone },
    end: { dateTime: new Date(endMs).toISOString(), timeZone }
  }
}

/** RFC 5545 RRULE (also RDATE or EXDATE), with or without its "RRULE:" prefix. */
export function recurrenceRule(value: string): string {
  const rule = value.trim()
  const prefixed = /^(RRULE|RDATE|EXDATE):/i.test(rule) ? rule : `RRULE:${rule}`
  if (!/^(RRULE|RDATE|EXDATE):\S+$/i.test(prefixed) || /[\r\n]/.test(prefixed)) {
    throw new GoogleToolError('--repeat takes an RRULE, e.g. FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10.')
  }
  return prefixed
}
