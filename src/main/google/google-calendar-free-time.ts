// `orca calendar suggest-time`: free slots for this account and the people named, from Google's
// free/busy, between set hours on weekdays in this account's zone. A calendar Google won't show is
// unknown, never free.
import { z } from 'zod'
import type { CalendarSuggestView, FreeSlot } from '../../shared/google/google-write-types'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import { CALENDAR, pickCalendar } from './google-calendar-read'
import { parseDuration } from './google-event-time'
import { addDays, weekdayOf, windowBound, zonedDate, zonedInstant } from './google-time-zone'

const MAX_DAYS = 14
const DEFAULT_DAYS = 7
const MAX_PEOPLE = 49
const MAX_SLOTS = 10
const PER_DAY = 3
// Picks within a day sit at least this far apart, so the choices differ.
const SPREAD_MS = 90 * 60_000

const Busy = z.object({ start: z.string(), end: z.string() })
const FreeBusySchema = z.object({
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(Busy).default([]),
      errors: z.array(z.object({ reason: z.string().optional() })).optional()
    })
  )
})

const REASONS: Record<string, string> = {
  notFound: "Orca can't see their calendar",
  groupTooBig: 'that group is too big to check',
  tooManyCalendarsRequested: 'too many people at once'
}

function parseHours(value: string | undefined): { from: string; to: string } {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? '09:00-17:00')
  const pad = (hours: string | undefined, minutes: string | undefined) =>
    `${String(hours).padStart(2, '0')}:${minutes}`
  const from = match ? pad(match[1], match[2]) : ''
  const to = match ? pad(match[3], match[4]) : ''
  if (!match || from >= to || to > '24:00') {
    throw new GoogleToolError('--hours takes a range like 09:00-17:00.')
  }
  return { from, to }
}

export async function suggestCalendarTime(
  api: GoogleApi,
  args: {
    with: string[]
    duration: string
    hours?: string
    from?: string
    to?: string
    now: number
  }
): Promise<CalendarSuggestView> {
  const people = [...new Set(args.with.map((entry) => entry.trim().toLowerCase()))].filter(
    (email) => email !== api.email.toLowerCase()
  )
  const named = people.find((entry) => !/^[^\s@]+@[^\s@]+$/.test(entry))
  if (named) {
    throw new GoogleToolError(
      `"${named.slice(0, 80)}" isn't an email address. \`orca contacts find <name>\` looks one up.`
    )
  }
  if (people.length > MAX_PEOPLE) {
    throw new GoogleToolError(`Check up to ${MAX_PEOPLE} people at once.`)
  }
  const minutes = parseDuration(args.duration)
  const hours = parseHours(args.hours)
  const calendar = await pickCalendar(api, undefined)
  const timeZone = calendar.timeZone ?? 'UTC'
  const today = zonedDate(args.now, timeZone)
  const bound = (value: string | undefined, end: boolean, fallback: number): number => {
    if (value === undefined) {
      return fallback
    }
    const parsed = windowBound(value, timeZone, end)
    if (!parsed) {
      throw new GoogleToolError(
        `${end ? '--to' : '--from'} takes a day (2026-11-03) or a time with its offset (2026-11-03T09:00:00-05:00).`
      )
    }
    return Date.parse(parsed)
  }
  const from = Math.max(args.now, bound(args.from, false, args.now))
  const to = Math.min(
    bound(args.to, true, zonedInstant(addDays(today, DEFAULT_DAYS), '00:00', timeZone)),
    from + MAX_DAYS * 86_400_000
  )
  if (to <= from) {
    throw new GoogleToolError('That window is already over; pick days ahead.')
  }
  const answer = await api.send(
    'calendar',
    {
      method: 'POST',
      url: `${CALENDAR}/freeBusy`,
      json: {
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        timeZone,
        items: [{ id: 'primary' }, ...people.map((id) => ({ id }))]
      }
    },
    parseGoogleJson(FreeBusySchema)
  )
  const mine = answer.calendars.primary
  if (!mine || (mine.errors?.length ?? 0) > 0) {
    throw new GoogleToolError("Google wouldn't share this account's own free/busy. Try again.")
  }
  const unknown: CalendarSuggestView['unknown'] = []
  const busy: { start: number; end: number }[] = []
  for (const id of ['primary', ...people]) {
    const entry = answer.calendars[id]
    const reason = entry ? entry.errors?.[0]?.reason : 'notFound'
    if (!entry || reason) {
      unknown.push({ email: id, reason: REASONS[reason ?? ''] ?? `Google said ${reason}` })
      continue
    }
    busy.push(
      ...entry.busy.map((span) => ({ start: Date.parse(span.start), end: Date.parse(span.end) }))
    )
  }
  return {
    account: api.email,
    now: args.now,
    timeZone,
    durationMinutes: minutes,
    hours,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    people,
    unknown,
    slots: freeSlots({ from, to, minutes, hours, timeZone, busy })
  }
}

function freeSlots(args: {
  from: number
  to: number
  minutes: number
  hours: { from: string; to: string }
  timeZone: string
  busy: { start: number; end: number }[]
}): FreeSlot[] {
  const length = args.minutes * 60_000
  const step = (args.minutes < 30 ? 15 : 30) * 60_000
  const slots: FreeSlot[] = []
  for (
    let day = zonedDate(args.from, args.timeZone);
    slots.length < MAX_SLOTS && zonedInstant(day, '00:00', args.timeZone) < args.to;
    day = addDays(day, 1)
  ) {
    const weekday = weekdayOf(day)
    if (weekday === 0 || weekday === 6) {
      continue
    }
    const open = zonedInstant(day, args.hours.from, args.timeZone)
    const close = Math.min(
      args.hours.to === '24:00'
        ? zonedInstant(addDays(day, 1), '00:00', args.timeZone)
        : zonedInstant(day, args.hours.to, args.timeZone),
      args.to
    )
    let picked = 0
    let last = -Infinity
    for (let start = open; start + length <= close && picked < PER_DAY; start += step) {
      const end = start + length
      if (start < args.from || start < last + SPREAD_MS) {
        continue
      }
      if (args.busy.some((span) => span.start < end && span.end > start)) {
        continue
      }
      slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() })
      picked += 1
      last = start
      if (slots.length >= MAX_SLOTS) {
        break
      }
    }
  }
  return slots
}
