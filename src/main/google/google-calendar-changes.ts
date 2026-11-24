// Calendar changes for "starting soon" rules: a sync token says cheaply whether anything changed, and
// a time-bounded list of the coming day is the schedule rules fire from.
import { z } from 'zod'
import type { CalendarEventSummary } from '../../shared/google/google-read-types'
import { MAX_MINUTES_BEFORE } from '../../shared/automation-google-triggers'
import { GoogleToolError, parseGoogleJson, type GoogleApi } from './google-api-client'
import { CALENDAR, EventSchema, eventSummary } from './google-calendar-read'

// A first sync pages through every event's id; past this many pages the schedule alone keeps it fresh.
const MAX_SEED_PAGES = 40
const MAX_SCHEDULE_PAGES = 4

const SyncPageSchema = z.object({
  items: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional()
})
const SchedulePageSchema = z.object({
  items: z.array(EventSchema).default([]),
  nextPageToken: z.string().optional()
})

export type UpcomingEvent = {
  summary: CalendarEventSummary
  startMs: number
  organizer?: string
  htmlLink?: string
}

const eventsUrl = (calendarId: string) =>
  new URL(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`)

async function syncPages(
  api: GoogleApi,
  calendarId: string,
  syncToken: string | undefined
): Promise<{ syncToken: string | undefined; changed: boolean }> {
  let pageToken: string | undefined
  let changed = false
  for (let page = 0; page < MAX_SEED_PAGES; page++) {
    const url = eventsUrl(calendarId)
    // Only ids: a check that finds nothing new costs about a kilobyte.
    url.searchParams.set('fields', 'items(id),nextPageToken,nextSyncToken')
    url.searchParams.set('maxResults', '2500')
    if (syncToken) {
      url.searchParams.set('syncToken', syncToken)
    }
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }
    const answer = await api.get('calendar', url.toString(), parseGoogleJson(SyncPageSchema))
    changed ||= answer.items.length > 0
    if (answer.nextSyncToken) {
      return { syncToken: answer.nextSyncToken, changed }
    }
    pageToken = answer.nextPageToken
    if (!pageToken) {
      break
    }
  }
  return { syncToken: undefined, changed: true }
}

/**
 * Whether the calendar changed since `syncToken`, and the token to keep. With no token (or one Google
 * dropped: 410) it seeds a new one and reports a change, so the schedule is rebuilt.
 */
export async function calendarChangedSince(
  api: GoogleApi,
  calendarId: string,
  syncToken: string | undefined
): Promise<{ syncToken: string | undefined; changed: boolean }> {
  if (!syncToken) {
    return { ...(await syncPages(api, calendarId, undefined)), changed: true }
  }
  try {
    return await syncPages(api, calendarId, syncToken)
  } catch (error) {
    if (error instanceof GoogleToolError && error.status === 410) {
      return { ...(await syncPages(api, calendarId, undefined)), changed: true }
    }
    throw error
  }
}

/** Timed events starting within the longest "minutes before", that the account hasn't declined. */
export async function upcomingEvents(
  api: GoogleApi,
  calendarId: string,
  now: number,
  horizonMs: number = (MAX_MINUTES_BEFORE + 60) * 60_000
): Promise<UpcomingEvent[]> {
  const found: UpcomingEvent[] = []
  let pageToken: string | undefined
  for (let page = 0; page < MAX_SCHEDULE_PAGES; page++) {
    const url = eventsUrl(calendarId)
    url.searchParams.set('timeMin', new Date(now).toISOString())
    url.searchParams.set('timeMax', new Date(now + horizonMs).toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('orderBy', 'startTime')
    url.searchParams.set('maxResults', '250')
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }
    const answer = await api.get('calendar', url.toString(), parseGoogleJson(SchedulePageSchema))
    for (const event of answer.items) {
      const startMs = event.start.dateTime ? Date.parse(event.start.dateTime) : Number.NaN
      const declined = event.attendees.some(
        (attendee) => attendee.self && attendee.responseStatus === 'declined'
      )
      if (event.status === 'cancelled' || declined || !(startMs > now)) {
        continue
      }
      const organizer = event.organizer?.displayName ?? event.organizer?.email
      found.push({
        summary: eventSummary(calendarId, event),
        startMs,
        ...(organizer ? { organizer } : {}),
        ...(event.htmlLink ? { htmlLink: event.htmlLink } : {})
      })
    }
    pageToken = answer.nextPageToken
    if (!pageToken) {
      break
    }
  }
  return found
}
