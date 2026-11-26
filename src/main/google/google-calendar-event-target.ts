// The event a calendar change acts on: one occurrence of a repeating event by default, its whole
// series with --series, and its length so a moved start keeps it.
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import {
  CALENDAR,
  EventSchema,
  nameOf,
  parseCalendarEventRef,
  pickCalendar,
  type CalendarEntry,
  type CalendarEvent
} from './google-calendar-read'
import { DEFAULT_EVENT_MINUTES } from './google-event-time'

/** The event a change acts on: the occurrence named, or its whole series with --series. */
export async function targetEvent(
  api: GoogleApi,
  args: { ref: string; calendar?: string; series?: boolean }
): Promise<{ calendar: CalendarEntry; event: CalendarEvent }> {
  const target = parseCalendarEventRef(args.ref, args.calendar)
  const calendar = await pickCalendar(api, target.calendarId)
  const fetch = (id: string) =>
    api.find(
      'calendar',
      `${CALENDAR}/calendars/${encodeURIComponent(calendar.id)}/events/${id}`,
      parseGoogleJson(EventSchema)
    )
  const event = await fetch(target.eventId)
  if (!event || event.status === 'cancelled') {
    throw new GoogleToolError(`There is no such event on ${nameOf(calendar)}.`)
  }
  if (args.series) {
    if (event.recurringEventId) {
      const series = await fetch(event.recurringEventId)
      if (!series) {
        throw new GoogleToolError('That repeating event is gone.')
      }
      return { calendar, event: series }
    }
    if (!event.recurrence) {
      throw new GoogleToolError("That event doesn't repeat; drop --series.")
    }
    return { calendar, event }
  }
  if (event.recurrence) {
    throw new GoogleToolError(
      'That is a whole repeating event. Add --series to change every occurrence, or use one occurrence’s ref from `orca calendar list`.'
    )
  }
  return { calendar, event }
}

export function eventLength(event: CalendarEvent): { minutes: number | null; days: number } {
  if (event.start.date && event.end.date) {
    const days = (Date.parse(event.end.date) - Date.parse(event.start.date)) / 86_400_000
    return { minutes: null, days: Math.max(1, days) }
  }
  const ms = Date.parse(event.end.dateTime ?? '') - Date.parse(event.start.dateTime ?? '')
  return { minutes: Number.isFinite(ms) ? Math.round(ms / 60_000) : DEFAULT_EVENT_MINUTES, days: 0 }
}
