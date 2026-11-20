import { afterEach, describe, expect, it } from 'vitest'
import {
  connectedGoogle,
  fakeGoogle,
  googleJson,
  NOW,
  type FakeRoute
} from './google-api.test-fixture'
import {
  createCalendarEvent,
  deleteCalendarEvent,
  respondToCalendarEvent,
  updateCalendarEvent
} from './google-calendar-write'
import { suggestCalendarTime } from './google-calendar-free-time'
import { parseDuration, parseEventTime } from './google-event-time'

let cleanup = (): void => {}
afterEach(() => cleanup())

type Sent = { url: URL; method: string; body: unknown }
const ZONE = 'America/New_York'
const EVENTS = '/calendar/v3/calendars/primary/events'

async function apiWith(routes: FakeRoute[]) {
  const google = await connectedGoogle()
  cleanup = google.cleanup
  const sent: Sent[] = []
  const recorder: FakeRoute = (url, init) => {
    if (init?.method && init.method !== 'GET') {
      sent.push({
        url,
        method: init.method,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body))
      })
    }
    return null
  }
  const primary: FakeRoute = (url) =>
    url.pathname === '/calendar/v3/users/me/calendarList/primary'
      ? googleJson(200, { id: 'primary', summary: 'Ada', timeZone: ZONE, primary: true })
      : null
  const fake = fakeGoogle([recorder, primary, ...routes])
  return {
    api: await google.client.googleApi(undefined, { http: fake.http, now: () => NOW }),
    sent
  }
}

const answer =
  (event: Record<string, unknown>): FakeRoute =>
  (url, init) =>
    url.pathname.startsWith(EVENTS) && init?.method && !['GET', 'DELETE'].includes(init.method)
      ? googleJson(200, { id: 'e1', ...event })
      : null

const occurrence = {
  id: 'e1_20261105T190000Z',
  recurringEventId: 'e1',
  summary: 'Standup',
  start: { dateTime: '2026-11-05T14:00:00-05:00', timeZone: ZONE },
  end: { dateTime: '2026-11-05T14:15:00-05:00', timeZone: ZONE },
  organizer: { email: 'sam@x.com' },
  attendees: [
    { email: 'sam@x.com', organizer: true, responseStatus: 'accepted' },
    { email: 'ada@acme.dev', self: true, responseStatus: 'needsAction', optional: true }
  ]
}
const deletes: FakeRoute = (url, init) =>
  init?.method === 'DELETE' && url.pathname.startsWith(`${EVENTS}/`)
    ? new Response(null, { status: 204 })
    : null
const gets =
  (events: Record<string, unknown>): FakeRoute =>
  (url, init) => {
    const id = url.pathname.slice(EVENTS.length + 1)
    return init?.method === 'GET' && url.pathname.startsWith(`${EVENTS}/`) && events[id]
      ? googleJson(200, events[id])
      : null
  }

describe('calendar create', () => {
  it('books a bare local time in the calendar zone, with guests, Meet and invites', async () => {
    const { api, sent } = await apiWith([
      answer({
        summary: 'Q3 review',
        start: { dateTime: '2026-11-05T14:00:00-05:00' },
        end: { dateTime: '2026-11-05T14:45:00-05:00' },
        attendees: [{ email: 'sam@x.com', responseStatus: 'needsAction' }],
        hangoutLink: 'https://meet.google.com/abc'
      })
    ])
    const view = await createCalendarEvent(api, {
      title: 'Q3 review',
      start: '2026-11-05T14:00',
      duration: '45m',
      with: ['Sam <sam@x.com>'],
      meet: true,
      notify: true,
      now: NOW
    })
    const post = sent[0]
    expect(post?.url.searchParams.get('sendUpdates')).toBe('all')
    expect(post?.url.searchParams.get('conferenceDataVersion')).toBe('1')
    expect(post?.body).toMatchObject({
      summary: 'Q3 review',
      start: { dateTime: '2026-11-05T19:00:00.000Z', timeZone: ZONE },
      end: { dateTime: '2026-11-05T19:45:00.000Z', timeZone: ZONE },
      attendees: [{ email: 'sam@x.com' }],
      conferenceData: { createRequest: { conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    })
    expect(view).toMatchObject({ action: 'created', notified: ['sam@x.com'], timeZone: ZONE })
    expect(view.event.meetUrl).toBe('https://meet.google.com/abc')
  })

  it('makes an all-day event whose end day is included, a repeat rule, and no emails with --no-notify', async () => {
    const { api, sent } = await apiWith([
      answer({ summary: 'Offsite', recurrence: ['RRULE:FREQ=YEARLY'] })
    ])
    await createCalendarEvent(api, {
      title: 'Offsite',
      start: '2026-11-12',
      end: '2026-11-13',
      allDay: true,
      repeat: 'FREQ=YEARLY',
      with: [],
      notify: false,
      now: NOW
    })
    expect(sent[0]?.url.searchParams.get('sendUpdates')).toBe('none')
    expect(sent[0]?.body).toMatchObject({
      start: { date: '2026-11-12' },
      end: { date: '2026-11-14' },
      recurrence: ['RRULE:FREQ=YEARLY']
    })
  })
})

describe('calendar update, delete and respond', () => {
  it('moves one occurrence and keeps its length', async () => {
    const { api, sent } = await apiWith([gets({ [occurrence.id]: occurrence }), answer(occurrence)])
    await updateCalendarEvent(api, {
      ref: `calendar:primary:event:${occurrence.id}`,
      start: '2026-11-05T15:00',
      with: [],
      without: [],
      notify: true,
      now: NOW
    })
    expect(sent[0]?.method).toBe('PATCH')
    expect(sent[0]?.url.pathname).toBe(`${EVENTS}/${occurrence.id}`)
    expect(sent[0]?.body).toEqual({
      start: { dateTime: '2026-11-05T20:00:00.000Z', timeZone: ZONE },
      end: { dateTime: '2026-11-05T20:15:00.000Z', timeZone: ZONE }
    })
  })

  it('acts on the series with --series, and refuses a series ref without it', async () => {
    const series = {
      ...occurrence,
      id: 'e1',
      recurringEventId: undefined,
      recurrence: ['RRULE:FREQ=DAILY']
    }
    const { api, sent } = await apiWith([
      gets({ [occurrence.id]: occurrence, e1: series }),
      deletes
    ])
    await expect(
      deleteCalendarEvent(api, { ref: 'calendar:primary:event:e1', notify: true, now: NOW })
    ).rejects.toThrow('Add --series')
    const view = await deleteCalendarEvent(api, {
      ref: `calendar:primary:event:${occurrence.id}`,
      series: true,
      notify: true,
      now: NOW
    })
    expect(sent).toEqual([expect.objectContaining({ method: 'DELETE' })])
    expect(sent[0]?.url.pathname).toBe(`${EVENTS}/e1`)
    // Sam organizes it, so deleting only takes it off this calendar and emails no one.
    expect(view).toMatchObject({ series: true, cancelled: false, notified: [] })
  })

  it('answers as this account, keeping the other guests and their fields', async () => {
    const { api, sent } = await apiWith([gets({ [occurrence.id]: occurrence }), answer(occurrence)])
    const view = await respondToCalendarEvent(api, {
      ref: `calendar:primary:event:${occurrence.id}`,
      answer: 'maybe',
      now: NOW
    })
    expect(sent[0]?.body).toEqual({
      attendees: [
        { email: 'sam@x.com', organizer: true, responseStatus: 'accepted' },
        { email: 'ada@acme.dev', self: true, responseStatus: 'tentative', optional: true }
      ]
    })
    expect(view.response).toBe('tentative')
  })
})

describe('calendar suggest-time', () => {
  it('offers weekday slots between the hours that are free for everyone, and names calendars it could not see', async () => {
    const { api, sent } = await apiWith([
      (url) =>
        url.pathname === '/calendar/v3/freeBusy'
          ? googleJson(200, {
              calendars: {
                primary: { busy: [{ start: '2026-11-04T14:00:00Z', end: '2026-11-04T15:00:00Z' }] },
                'sam@x.com': {
                  busy: [{ start: '2026-11-04T15:00:00Z', end: '2026-11-04T16:00:00Z' }]
                },
                'kim@x.com': { errors: [{ reason: 'notFound' }] }
              }
            })
          : null
    ])
    // NOW is Tue 3 Nov 14:05 New York; Wednesday's 09:00-11:00 is busy for one of us.
    const view = await suggestCalendarTime(api, {
      with: ['sam@x.com', 'kim@x.com'],
      duration: '30m',
      from: '2026-11-04',
      to: '2026-11-04',
      now: NOW
    })
    expect(sent[0]?.body).toMatchObject({
      items: [{ id: 'primary' }, { id: 'sam@x.com' }, { id: 'kim@x.com' }]
    })
    expect(view.unknown).toEqual([{ email: 'kim@x.com', reason: "Orca can't see their calendar" }])
    expect(view.slots[0]).toEqual({
      start: '2026-11-04T16:00:00.000Z',
      end: '2026-11-04T16:30:00.000Z'
    })
    expect(view.slots).toHaveLength(3)
  })
})

describe('event times', () => {
  it('reads days, local times in the zone, offsets and lengths', () => {
    expect(parseEventTime('2026-11-05', ZONE, '--start')).toEqual({
      kind: 'day',
      date: '2026-11-05'
    })
    // 1 Nov 2026 is the day New York leaves daylight time.
    expect(parseEventTime('2026-11-01T09:00', ZONE, '--start')).toEqual({
      kind: 'time',
      ms: Date.parse('2026-11-01T14:00:00Z')
    })
    expect(parseEventTime('2026-10-31T09:00', ZONE, '--start')).toEqual({
      kind: 'time',
      ms: Date.parse('2026-10-31T13:00:00Z')
    })
    expect(parseEventTime('2026-11-05T10:00:00+01:00', ZONE, '--start')).toEqual({
      kind: 'time',
      ms: Date.parse('2026-11-05T09:00:00Z')
    })
    expect(() => parseEventTime('tomorrow', ZONE, '--start')).toThrow('--start takes a time')
    expect([
      parseDuration('30m'),
      parseDuration('1h'),
      parseDuration('1h30m'),
      parseDuration('90')
    ]).toEqual([30, 60, 90, 90])
    expect(() => parseDuration('soon')).toThrow('--duration')
  })
})
