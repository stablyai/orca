// Calendar writes for `orca calendar create|update|delete|respond`. Update, delete and respond act
// on one occurrence of a repeating event unless --series; invitees get Google's normal emails
// unless --no-notify.
import { randomUUID } from 'node:crypto'
import type { CalendarWriteView } from '../../shared/google/google-write-types'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import { eventLength, targetEvent } from './google-calendar-event-target'
import {
  CALENDAR,
  EventSchema,
  eventSummary,
  nameOf,
  pickCalendar,
  type CalendarEntry,
  type CalendarEvent
} from './google-calendar-read'
import { addDays } from './google-time-zone'
import {
  parseDuration,
  parseEventTime,
  recurrenceRule,
  startAndEnd,
  validTimeZone
} from './google-event-time'

export type CalendarEventFields = {
  title?: string
  start?: string
  end?: string
  duration?: string
  allDay?: boolean
  tz?: string
  where?: string
  body?: string
  with: string[]
  meet?: boolean
}

type Notify = { notify: boolean }

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

function emails(entries: string[]): string[] {
  return entries.map((entry) => {
    const email = (/<([^<>]+)>/.exec(entry)?.[1] ?? entry).trim().toLowerCase()
    if (!EMAIL.test(email)) {
      throw new GoogleToolError(
        `"${entry.slice(0, 80)}" isn't an email address. \`orca contacts find <name>\` looks one up.`
      )
    }
    return email
  })
}

const meetRequest = () => ({
  createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } }
})

function writeUrl(calendarId: string, eventId: string | null, notify: boolean): string {
  const url = new URL(
    `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${eventId}` : ''}`
  )
  url.searchParams.set('conferenceDataVersion', '1')
  url.searchParams.set('sendUpdates', notify ? 'all' : 'none')
  return url.toString()
}

function view(
  api: GoogleApi,
  calendar: CalendarEntry,
  event: CalendarEvent,
  rest: Pick<CalendarWriteView, 'action' | 'series' | 'notified' | 'response' | 'cancelled'>,
  now: number
): CalendarWriteView {
  return {
    account: api.email,
    now,
    timeZone: calendar.timeZone ?? 'UTC',
    calendar: { id: calendar.id, name: nameOf(calendar) },
    event: eventSummary(calendar.id, event),
    ...rest
  }
}

/** The guests Google emails about a change: everyone but this account, when notifying. */
function guests(event: CalendarEvent, notify: boolean): string[] {
  return notify
    ? event.attendees.filter((attendee) => !attendee.self).map((attendee) => attendee.email)
    : []
}

export async function createCalendarEvent(
  api: GoogleApi,
  args: CalendarEventFields & Notify & { calendar?: string; repeat?: string; now: number }
): Promise<CalendarWriteView> {
  if (!args.title?.trim()) {
    throw new GoogleToolError('Give it a --title.')
  }
  if (!args.start) {
    throw new GoogleToolError('Say when with --start (2026-11-04T10:00, or a day with --all-day).')
  }
  const calendar = await pickCalendar(api, args.calendar)
  const timeZone = validTimeZone(args.tz) ?? calendar.timeZone ?? 'UTC'
  const start = parseEventTime(args.start, timeZone, '--start')
  if (args.allDay && start.kind !== 'day') {
    throw new GoogleToolError('--all-day takes days: --start 2026-11-05 [--end 2026-11-06].')
  }
  if (!args.allDay && start.kind === 'day') {
    throw new GoogleToolError('--start is a day: add --all-day, or give a time (2026-11-05T10:00).')
  }
  const end = args.end ? parseEventTime(args.end, timeZone, '--end') : null
  if (end && args.duration) {
    throw new GoogleToolError('Pick one: --end or --duration.')
  }
  const minutes = args.duration ? parseDuration(args.duration) : null
  const repeat = args.repeat ? recurrenceRule(args.repeat) : null
  const attendees = emails(args.with)
  const event = await api.send(
    'calendar',
    {
      method: 'POST',
      url: writeUrl(calendar.id, null, args.notify),
      json: {
        summary: args.title.trim(),
        ...startAndEnd(start, end, minutes, timeZone),
        ...(args.where ? { location: args.where } : {}),
        ...(args.body ? { description: args.body } : {}),
        ...(attendees.length > 0 ? { attendees: attendees.map((email) => ({ email })) } : {}),
        ...(repeat ? { recurrence: [repeat] } : {}),
        ...(args.meet ? { conferenceData: meetRequest() } : {})
      }
    },
    parseGoogleJson(EventSchema)
  )
  return view(
    api,
    calendar,
    event,
    { action: 'created', series: repeat !== null, notified: guests(event, args.notify) },
    args.now
  )
}

export async function updateCalendarEvent(
  api: GoogleApi,
  args: CalendarEventFields &
    Notify & { ref: string; calendar?: string; series?: boolean; without: string[]; now: number }
): Promise<CalendarWriteView> {
  const { calendar, event } = await targetEvent(api, args)
  const timeZone = validTimeZone(args.tz) ?? event.start.timeZone ?? calendar.timeZone ?? 'UTC'
  const patch: Record<string, unknown> = {}
  if (args.title !== undefined) {
    patch.summary = args.title.trim()
  }
  if (args.where !== undefined) {
    patch.location = args.where
  }
  if (args.body !== undefined) {
    patch.description = args.body
  }
  if (args.start || args.end || args.duration || args.tz) {
    const length = eventLength(event)
    const start = parseEventTime(
      args.start ?? event.start.dateTime ?? event.start.date ?? '',
      timeZone,
      '--start'
    )
    const end = args.end ? parseEventTime(args.end, timeZone, '--end') : null
    const minutes = args.duration ? parseDuration(args.duration) : null
    // A moved start keeps the event's length.
    const kept =
      end || minutes !== null
        ? { end, minutes }
        : start.kind === 'day'
          ? {
              end: { kind: 'day' as const, date: addDays(start.date, length.days - 1) },
              minutes: null
            }
          : { end: null, minutes: length.minutes }
    Object.assign(patch, startAndEnd(start, kept.end, kept.minutes, timeZone))
  }
  if (args.with.length > 0 || args.without.length > 0) {
    const add = emails(args.with)
    const drop = new Set(emails(args.without))
    const kept = event.attendees.filter((attendee) => !drop.has(attendee.email.toLowerCase()))
    const known = new Set(kept.map((attendee) => attendee.email.toLowerCase()))
    patch.attendees = [
      ...kept,
      ...add.filter((email) => !known.has(email)).map((email) => ({ email }))
    ]
  }
  if (args.meet && !event.hangoutLink && !event.conferenceData) {
    patch.conferenceData = meetRequest()
  }
  if (Object.keys(patch).length === 0) {
    throw new GoogleToolError(
      'Nothing to change: pass --title, --start, --end, --duration, --where, --body, --with, --without or --meet.'
    )
  }
  const updated = await api.send(
    'calendar',
    { method: 'PATCH', url: writeUrl(calendar.id, event.id, args.notify), json: patch },
    parseGoogleJson(EventSchema)
  )
  return view(
    api,
    calendar,
    updated,
    {
      action: 'updated',
      series: updated.recurrence !== undefined,
      notified: guests(updated, args.notify)
    },
    args.now
  )
}

export async function deleteCalendarEvent(
  api: GoogleApi,
  args: Notify & { ref: string; calendar?: string; series?: boolean; now: number }
): Promise<CalendarWriteView> {
  const { calendar, event } = await targetEvent(api, args)
  await api.send(
    'calendar',
    { method: 'DELETE', url: writeUrl(calendar.id, event.id, args.notify) },
    () => true
  )
  // Only the organizer's cancel reaches the guests; anyone else just takes it off their calendar.
  const organizer = event.organizer?.self === true
  return view(
    api,
    calendar,
    event,
    {
      action: 'deleted',
      series: event.recurrence !== undefined,
      notified: organizer ? guests(event, args.notify) : [],
      cancelled: organizer
    },
    args.now
  )
}

const ANSWERS = { accept: 'accepted', decline: 'declined', maybe: 'tentative' } as const

export async function respondToCalendarEvent(
  api: GoogleApi,
  args: {
    ref: string
    answer: keyof typeof ANSWERS
    calendar?: string
    series?: boolean
    now: number
  }
): Promise<CalendarWriteView> {
  const response = ANSWERS[args.answer]
  const { calendar, event } = await targetEvent(api, args)
  const self = event.attendees.find((attendee) => attendee.self)
  if (!self) {
    throw new GoogleToolError(
      `${api.email} isn't invited to that event, so there is nothing to answer.`
    )
  }
  if (self.organizer) {
    throw new GoogleToolError(`${api.email} organizes that event, so there is nothing to answer.`)
  }
  const updated = await api.send(
    'calendar',
    {
      method: 'PATCH',
      url: writeUrl(calendar.id, event.id, true),
      json: {
        attendees: event.attendees.map((attendee) =>
          attendee.self ? { ...attendee, responseStatus: response } : attendee
        )
      }
    },
    parseGoogleJson(EventSchema)
  )
  return view(
    api,
    calendar,
    updated,
    {
      action: 'responded',
      series: updated.recurrence !== undefined,
      notified: [],
      response
    },
    args.now
  )
}
