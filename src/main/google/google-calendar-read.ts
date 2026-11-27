// Calendar reads for `orca calendar list|get`: events in a window (today and tomorrow by default,
// in the calendar's own time zone), one event in full, or the calendars there are. Repeating events
// come back as single occurrences.
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import type {
  CalendarAttendee,
  CalendarEventSummary,
  CalendarEventView,
  CalendarListView,
  CalendarsView
} from '../../shared/google/google-read-types'
import { TOOL_LIST_PAGE_SIZE } from '../../shared/tool-output-limits'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import { addDays, windowBound, zonedDate, zonedMidnight } from './google-time-zone'

export const CALENDAR = 'https://www.googleapis.com/calendar/v3'
const LIST_MAX = 250
// 20 pages of 250: up to 5,000 calendars.
const MAX_CALENDAR_LIST_PAGES = 20

const CalendarEntrySchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    summary: z.string().optional(),
    summaryOverride: z.string().optional(),
    timeZone: z.string().optional(),
    primary: z.boolean().optional(),
    accessRole: z.string().optional()
  })
)
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>
const CalendarListSchema = lazyZodSchema(() =>
  z.object({
    items: z.array(CalendarEntrySchema).default([]),
    nextPageToken: z.string().optional()
  })
)

const When = lazyZodSchema(() =>
  z.object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional()
  })
)
export const EventSchema = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    status: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    htmlLink: z.string().optional(),
    hangoutLink: z.string().optional(),
    recurringEventId: z.string().optional(),
    // Set only on a repeating event's series, never on one occurrence.
    recurrence: z.array(z.string()).optional(),
    start: When.default({}),
    end: When.default({}),
    organizer: z
      .object({
        email: z.string().optional(),
        displayName: z.string().optional(),
        self: z.boolean().optional()
      })
      .optional(),
    attendees: z
      .array(
        z
          .object({
            email: z.string().default(''),
            displayName: z.string().optional(),
            responseStatus: z
              .enum(['accepted', 'declined', 'tentative', 'needsAction'])
              .catch('needsAction')
              .default('needsAction'),
            organizer: z.boolean().optional(),
            self: z.boolean().optional()
          })
          // A write sends attendees back whole; fields Orca doesn't show (optional, comment) stay.
          .passthrough()
      )
      .default([]),
    conferenceData: z
      .object({
        entryPoints: z
          .array(z.object({ entryPointType: z.string().optional(), uri: z.string().optional() }))
          .default([])
      })
      .optional()
  })
)
export type CalendarEvent = z.infer<typeof EventSchema>
const EventsSchema = lazyZodSchema(() =>
  z.object({
    items: z.array(EventSchema).default([]),
    nextPageToken: z.string().optional()
  })
)

/** `calendar:<calendar id>:event:<event id>`, as list prints it; a bare event id is on --calendar. */
export function parseCalendarEventRef(
  ref: string,
  calendar: string | undefined
): { calendarId: string | undefined; eventId: string } {
  const trimmed = ref.trim()
  const typed = /^calendar:(.+):event:([A-Za-z0-9_]+)$/.exec(trimmed)
  if (typed?.[1] && typed[2]) {
    return { calendarId: typed[1], eventId: typed[2] }
  }
  if (/^[A-Za-z0-9_]+$/.test(trimmed)) {
    return { calendarId: calendar, eventId: trimmed }
  }
  throw new GoogleToolError(
    `"${trimmed.slice(0, 80)}" isn't an event id. Use the calendar:…:event:… ref \`orca calendar list\` prints.`
  )
}

export const nameOf = (entry: CalendarEntry) => entry.summaryOverride ?? entry.summary ?? entry.id

/** The calendar named by id or by its name; the primary one when none is named. */
export async function pickCalendar(
  api: GoogleApi,
  wanted: string | undefined
): Promise<CalendarEntry> {
  const id = wanted?.trim() || 'primary'
  if (id === 'primary' || id.includes('@')) {
    const entry = await api.find(
      'calendar',
      `${CALENDAR}/users/me/calendarList/${encodeURIComponent(id)}`,
      parseGoogleJson(CalendarEntrySchema)
    )
    if (!entry) {
      throw new GoogleToolError(
        `${api.email} has no calendar ${id}. \`orca calendar list --calendars\` lists them.`
      )
    }
    return entry
  }
  const all = await listCalendarEntries(api)
  const key = id.toLowerCase()
  const matches = all.filter((entry) => nameOf(entry).toLowerCase() === key)
  if (matches.length === 1 && matches[0]) {
    return matches[0]
  }
  throw new GoogleToolError(
    matches.length === 0
      ? `No calendar is named "${id}". \`orca calendar list --calendars\` lists them.`
      : `Several calendars are named "${id}"; pass one's id: ${matches.map((entry) => entry.id).join(', ')}.`
  )
}

async function listCalendarEntries(api: GoogleApi): Promise<CalendarEntry[]> {
  const url = new URL(`${CALENDAR}/users/me/calendarList`)
  url.searchParams.set('maxResults', String(LIST_MAX))
  const entries: CalendarEntry[] = []
  let pageToken: string | undefined
  for (let pageIndex = 0; pageIndex < MAX_CALENDAR_LIST_PAGES; pageIndex++) {
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }
    const page = await api.get('calendar', url.toString(), parseGoogleJson(CalendarListSchema))
    entries.push(...page.items)
    pageToken = page.nextPageToken
    if (!pageToken) {
      break
    }
  }
  if (pageToken) {
    throw new GoogleToolError(
      `The calendar list exceeds the ${MAX_CALENDAR_LIST_PAGES}-page limit, so the listing is incomplete. Pass a calendar id instead of a name.`
    )
  }
  return entries
}

export function eventSummary(calendarId: string, event: CalendarEvent): CalendarEventSummary {
  const meet =
    event.hangoutLink ??
    event.conferenceData?.entryPoints.find((entry) => entry.entryPointType === 'video')?.uri
  return {
    ref: `calendar:${calendarId}:event:${event.id}`,
    title: event.summary ?? '(no title)',
    start: event.start.dateTime ?? event.start.date ?? '',
    end: event.end.dateTime ?? event.end.date ?? '',
    allDay: event.start.dateTime === undefined,
    ...(event.location ? { location: event.location } : {}),
    ...(meet ? { meetUrl: meet } : {}),
    attendees: event.attendees.map((attendee): CalendarAttendee => ({
      email: attendee.email,
      ...(attendee.displayName ? { name: attendee.displayName } : {}),
      response: attendee.responseStatus,
      ...(attendee.organizer ? { organizer: true } : {}),
      ...(attendee.self ? { self: true } : {})
    })),
    recurring: event.recurringEventId !== undefined,
    ...(event.status ? { status: event.status } : {})
  }
}

export async function listCalendarEvents(
  api: GoogleApi,
  args: { calendar?: string; from?: string; to?: string; pageToken?: string; now: number }
): Promise<CalendarListView> {
  const calendar = await pickCalendar(api, args.calendar)
  const timeZone = calendar.timeZone ?? 'UTC'
  const today = zonedDate(args.now, timeZone)
  const bound = (value: string | undefined, end: boolean, fallback: string): string => {
    if (value === undefined) {
      return fallback
    }
    const parsed = windowBound(value, timeZone, end)
    if (!parsed) {
      throw new GoogleToolError(
        `${end ? '--to' : '--from'} takes a day (2026-11-03) or a time with its offset (2026-11-03T09:00:00-05:00).`
      )
    }
    return parsed
  }
  const from = bound(args.from, false, zonedMidnight(today, timeZone))
  const to = bound(args.to, true, zonedMidnight(addDays(today, 2), timeZone))
  const url = new URL(`${CALENDAR}/calendars/${encodeURIComponent(calendar.id)}/events`)
  url.searchParams.set('timeMin', from)
  url.searchParams.set('timeMax', to)
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('orderBy', 'startTime')
  url.searchParams.set('maxResults', String(TOOL_LIST_PAGE_SIZE))
  if (args.pageToken) {
    url.searchParams.set('pageToken', args.pageToken)
  }
  const events = await api.get('calendar', url.toString(), parseGoogleJson(EventsSchema))
  return {
    account: api.email,
    now: args.now,
    timeZone,
    calendar: { id: calendar.id, name: nameOf(calendar) },
    from,
    to,
    events: events.items
      .filter((event) => event.status !== 'cancelled')
      .map((event) => eventSummary(calendar.id, event)),
    ...(events.nextPageToken ? { nextPageToken: events.nextPageToken } : {})
  }
}

export async function getCalendarEvent(
  api: GoogleApi,
  args: { ref: string; calendar?: string; now: number }
): Promise<CalendarEventView> {
  const target = parseCalendarEventRef(args.ref, args.calendar)
  const calendar = await pickCalendar(api, target.calendarId)
  const event = await api.find(
    'calendar',
    `${CALENDAR}/calendars/${encodeURIComponent(calendar.id)}/events/${target.eventId}`,
    parseGoogleJson(EventSchema)
  )
  if (!event) {
    throw new GoogleToolError(`There is no such event on ${nameOf(calendar)}.`)
  }
  const organizer = event.organizer?.displayName ?? event.organizer?.email
  return {
    account: api.email,
    now: args.now,
    timeZone: calendar.timeZone ?? 'UTC',
    calendar: { id: calendar.id, name: nameOf(calendar) },
    event: {
      ...eventSummary(calendar.id, event),
      ...(event.description ? { description: event.description } : {}),
      ...(organizer ? { organizer } : {}),
      ...(event.htmlLink ? { htmlLink: event.htmlLink } : {})
    }
  }
}

export async function listCalendars(api: GoogleApi, now: number): Promise<CalendarsView> {
  const entries = await listCalendarEntries(api)
  const primary = entries.find((entry) => entry.primary)
  return {
    account: api.email,
    now,
    timeZone: primary?.timeZone ?? 'UTC',
    calendars: entries.map((entry) => ({
      id: entry.id,
      name: nameOf(entry),
      primary: entry.primary === true,
      access: entry.accessRole ?? 'reader'
    }))
  }
}
