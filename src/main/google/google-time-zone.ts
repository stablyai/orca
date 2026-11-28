// Calendar windows in the calendar's own time zone: "today" is that zone's day, not this host's.

import { hasImpossibleLeadingDate } from '../../shared/validation/calendar-date'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The calendar day (YYYY-MM-DD) an instant falls on in a time zone. */
export function zonedDate(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(epochMs))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

/** The zone's UTC offset at local midnight, as RFC 3339 writes it (+05:30, -04:00, Z). */
function offsetOn(date: string, timeZone: string): string {
  const midnight = zonedInstant(date, '00:00', timeZone)
  // Where the clocks skip midnight (Beirut, Cairo), the day starts as the old offset reaches 00:00.
  const skipped = midnight + zoneOffsetMs(midnight, timeZone) !== Date.parse(`${date}T00:00:00Z`)
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(skipped ? midnight - 1 : midnight))
    .find((part) => part.type === 'timeZoneName')?.value
  const offset = name?.replace(/^GMT/, '') ?? ''
  return offset === '' ? 'Z' : offset
}

/** Midnight at the start of a day in the zone, as RFC 3339. */
export function zonedMidnight(date: string, timeZone: string): string {
  return `${date}T00:00:00${offsetOn(date, timeZone)}`
}

/** A --from/--to value: a day (its midnight in the zone; `--to` days are included) or RFC 3339. */
export function windowBound(value: string, timeZone: string, end: boolean): string | null {
  const trimmed = value.trim()
  if (hasImpossibleLeadingDate(trimmed)) {
    return null
  }
  if (DATE.test(trimmed)) {
    return zonedMidnight(end ? addDays(trimmed, 1) : trimmed, timeZone)
  }
  return Number.isNaN(Date.parse(trimmed)) || !/T\d{2}:\d{2}/.test(trimmed) ? null : trimmed
}

/** How far the zone's wall clock is ahead of UTC at an instant, in ms. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  )
  return wall - Math.floor(epochMs / 1000) * 1000
}

/** The instant a wall-clock time (YYYY-MM-DD, HH:MM) falls on in the zone. */
export function zonedInstant(date: string, time: string, timeZone: string): number {
  const wall = Date.parse(`${date}T${time}:00Z`)
  const first = wall - zoneOffsetMs(wall, timeZone)
  // Once more from the first guess, for a day the clocks change.
  return wall - zoneOffsetMs(first, timeZone)
}

/** 0 for Sunday through 6 for Saturday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay()
}
