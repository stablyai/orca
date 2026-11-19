import { afterEach, describe, expect, it } from 'vitest'
import {
  connectedGoogle,
  fakeGoogle,
  googleJson,
  NOW,
  type FakeRoute
} from './google-api.test-fixture'
import { getCalendarEvent, listCalendarEvents, listCalendars } from './google-calendar-read'
import { findContacts } from './google-contacts-read'
import { TOOL_TEXT_PAGE_CHARS } from '../../shared/tool-output-limits'
import { downloadGmailAttachment, parseGmailRef, readGmail, searchGmail } from './google-gmail-read'

let cleanup = (): void => {}
afterEach(() => cleanup())

async function apiWith(routes: FakeRoute[], emails?: string[]) {
  const google = await connectedGoogle(emails)
  cleanup = google.cleanup
  const fake = fakeGoogle(routes)
  return {
    api: google.client.googleApi(undefined, { http: fake.http, now: () => NOW }),
    fake,
    google
  }
}

const b64 = (text: string) => Buffer.from(text).toString('base64url')
const headers = (from: string, subject: string, to = 'ada@acme.dev') => [
  { name: 'From', value: from },
  { name: 'To', value: to },
  { name: 'Subject', value: subject },
  { name: 'Date', value: 'Tue, 3 Nov 2026 09:00:00 -0500' }
]

const GMAIL = '/gmail/v1/users/me'

describe('Gmail search', () => {
  it('lists threads with the latest sender, the subject, unread state and the next page', async () => {
    const { api, fake } = await apiWith([
      (url) =>
        url.pathname === `${GMAIL}/threads`
          ? googleJson(200, {
              threads: [{ id: '18c2f0a1b2c3d4e5' }],
              nextPageToken: 'p2',
              resultSizeEstimate: 42
            })
          : null,
      (url) =>
        url.pathname === `${GMAIL}/threads/18c2f0a1b2c3d4e5`
          ? googleJson(200, {
              id: '18c2f0a1b2c3d4e5',
              messages: [
                {
                  id: 'm1',
                  threadId: '18c2f0a1b2c3d4e5',
                  internalDate: String(NOW - 7_200_000),
                  payload: { headers: headers('Sam <sam@x.com>', 'Q3 plan') }
                },
                {
                  id: 'm2',
                  threadId: '18c2f0a1b2c3d4e5',
                  internalDate: String(NOW),
                  labelIds: ['UNREAD', 'INBOX'],
                  snippet: 'Sounds good',
                  payload: { headers: headers('Ada <ada@acme.dev>', 'Re: Q3 plan') }
                }
              ]
            })
          : null
    ])
    const view = await searchGmail(api, { query: 'from:sam' })
    expect(fake.calls[0]?.searchParams.get('q')).toBe('from:sam')
    expect(fake.calls[0]?.searchParams.get('maxResults')).toBe('20')
    expect(fake.calls[1]?.searchParams.getAll('metadataHeaders')).toEqual([
      'From',
      'Subject',
      'Date'
    ])
    expect(view).toEqual({
      account: 'ada@acme.dev',
      estimate: 42,
      nextPageToken: 'p2',
      threads: [
        {
          ref: 'gmail:thread:18c2f0a1b2c3d4e5',
          subject: 'Q3 plan',
          from: 'Ada <ada@acme.dev>',
          at: NOW,
          snippet: 'Sounds good',
          messages: 2,
          unread: true
        }
      ]
    })
  })

  it('takes Orca refs, bare thread ids and Gmail links, and refuses anything else', () => {
    expect(parseGmailRef('gmail:msg:abc123')).toEqual({ kind: 'msg', id: 'abc123' })
    expect(parseGmailRef('https://mail.google.com/mail/u/0/#inbox/18c2f0a1b2c3d4e5')).toEqual({
      kind: 'thread',
      id: '18c2f0a1b2c3d4e5'
    })
    expect(() => parseGmailRef('https://mail.google.com/mail/u/0/#inbox/FMfcgzQ')).toThrow(
      'no thread id'
    )
    expect(() => parseGmailRef('drop table')).toThrow("isn't a Gmail id")
  })
})

describe('Gmail read', () => {
  const thread = (bodies: string[]) => ({
    id: 't1',
    messages: bodies.map((body, index) => ({
      id: `m${index + 1}`,
      threadId: 't1',
      internalDate: String(NOW + index),
      payload: {
        mimeType: 'multipart/mixed',
        headers: headers('Sam <sam@x.com>', 'Plan'),
        parts: [
          {
            partId: '0',
            mimeType: 'multipart/alternative',
            parts: [
              { partId: '0.0', mimeType: 'text/plain', body: { data: b64(body) } },
              { partId: '0.1', mimeType: 'text/html', body: { data: b64(`<p>${body}</p>`) } }
            ]
          },
          {
            partId: '1',
            mimeType: 'application/pdf',
            filename: 'plan.pdf',
            body: { attachmentId: 'ANGjdJ-volatile', size: 2048 }
          }
        ]
      }
    }))
  })

  it('reads a thread as plain text with its attachments as stable refs', async () => {
    const { api } = await apiWith([
      (url) =>
        url.pathname === `${GMAIL}/threads/t1` ? googleJson(200, thread(['Hi Ada', 'Done'])) : null
    ])
    const view = await readGmail(api, { ref: 'gmail:thread:t1' })
    expect(view.subject).toBe('Plan')
    expect(view.messages.map((message) => message.body)).toEqual(['Hi Ada', 'Done'])
    expect(view.messages[0]?.attachments).toEqual([
      { ref: 'gmail:att:m1:1', name: 'plan.pdf', type: 'application/pdf', size: 2048 }
    ])
    expect(view.nextOffset).toBeUndefined()
  })

  it('falls back to the HTML as text when a message has no plain part', async () => {
    const { api } = await apiWith([
      (url) =>
        url.pathname === `${GMAIL}/messages/m9`
          ? googleJson(200, {
              id: 'm9',
              threadId: 't9',
              payload: {
                mimeType: 'text/html',
                headers: headers('Sam <sam@x.com>', 'Hi'),
                body: {
                  data: b64(
                    '<style>p{}</style><p>Hello&nbsp;<b>Ada</b> &amp; team</p><ul><li>one</li></ul>'
                  )
                }
              }
            })
          : null
    ])
    const view = await readGmail(api, { ref: 'gmail:msg:m9' })
    expect(view.messages[0]?.body).toBe('Hello Ada & team\n- one')
    expect(view.ref).toBe('gmail:thread:t9')
  })

  it('pages a long thread by offset across its bodies, never repeating or skipping', async () => {
    const bodies = ['a'.repeat(10_000), 'b'.repeat(12_000), 'tail']
    const { api } = await apiWith([
      (url) => (url.pathname === `${GMAIL}/threads/t1` ? googleJson(200, thread(bodies)) : null)
    ])
    const first = await readGmail(api, { ref: 'gmail:thread:t1' })
    const cut = first.nextOffset ?? 0
    // Headers and attachment lines take part of the page, so the second body is cut short of it.
    expect(cut).toBeGreaterThan(10_000)
    expect(cut).toBeLessThan(10_000 + TOOL_TEXT_PAGE_CHARS - 10_000)
    expect(first.messages.map((message) => message.body.length)).toEqual([10_000, cut - 10_000])
    expect(first.messages[1]?.part).toEqual({ from: 0, to: cut - 10_000, of: 12_000 })
    const second = await readGmail(api, { ref: 'gmail:thread:t1', offset: cut })
    expect(second.messages[0]?.part).toEqual({ from: cut - 10_000, to: 12_000, of: 12_000 })
    expect(second.nextOffset).toBeUndefined()
    const pages = [...first.messages, ...second.messages].map((message) => message.body)
    expect(pages.join('')).toBe(bodies.join(''))
  })

  it('always moves on, even when long headers fill a page', async () => {
    const long = thread(['x'.repeat(30_000)])
    const cc = 'c'.repeat(50_000)
    long.messages[0]?.payload.headers.push({ name: 'Cc', value: cc })
    const { api } = await apiWith([
      (url) => (url.pathname === `${GMAIL}/threads/t1` ? googleJson(200, long) : null)
    ])
    const view = await readGmail(api, { ref: 'gmail:thread:t1' })
    expect(view.messages[0]?.cc).toMatch(/ \(cut\)$/)
    expect(view.messages[0]?.body.length).toBeGreaterThan(0)
    expect(view.nextOffset).toBe(view.messages[0]?.body.length)
  })

  it('downloads an attachment by its message and part, not Gmail’s changing id', async () => {
    const { api, fake } = await apiWith([
      (url) =>
        url.pathname === `${GMAIL}/messages/m1` ? googleJson(200, thread(['x']).messages[0]) : null,
      (url) =>
        url.pathname === `${GMAIL}/messages/m1/attachments/ANGjdJ-volatile`
          ? googleJson(200, { data: b64('%PDF'), size: 4 })
          : null
    ])
    const file = await downloadGmailAttachment(api, 'gmail:att:m1:1')
    expect(Buffer.from(file.data, 'base64').toString()).toBe('%PDF')
    expect(file.name).toBe('plan.pdf')
    expect(fake.calls).toHaveLength(2)
    await expect(downloadGmailAttachment(api, 'gmail:att:m1:7')).rejects.toThrow(
      'no such attachment'
    )
  })
})

describe('the Google API client', () => {
  it('says how to turn on an API that is off, with the Console link', async () => {
    const { api } = await apiWith([
      () =>
        googleJson(403, {
          error: {
            message: 'Gmail API has not been used in project 42 before or it is disabled.',
            details: [
              {
                reason: 'SERVICE_DISABLED',
                metadata: {
                  activationUrl:
                    'https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42'
                }
              }
            ]
          }
        })
    ])
    await expect(searchGmail(api, { query: 'x' })).rejects.toThrow(
      'Ask your owner to turn it on: https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42'
    )
  })

  it('needs --account when several accounts are connected, and names them', async () => {
    const google = await connectedGoogle(['ada@acme.dev', 'ada@gmail.com'])
    cleanup = google.cleanup
    // Accounts come in the order the store lists them, which varies by file system.
    expect(() => google.client.googleApi(undefined)).toThrow(
      /ada@acme\.dev, ada@gmail\.com|ada@gmail\.com, ada@acme\.dev/
    )
    expect(google.client.googleApi('ADA@gmail.com').email).toBe('ada@gmail.com')
    expect(() => google.client.googleApi('sam@x.com')).toThrow("isn't connected")
  })
})

const CAL = '/calendar/v3'
const primary = (url: URL) =>
  url.pathname === `${CAL}/users/me/calendarList/primary`
    ? googleJson(200, {
        id: 'ada@acme.dev',
        summary: 'ada@acme.dev',
        timeZone: 'America/New_York',
        primary: true,
        accessRole: 'owner'
      })
    : null

describe('Calendar', () => {
  const event = {
    id: 'e1_20261103T200000Z',
    summary: 'Design review',
    recurringEventId: 'e1',
    start: { dateTime: '2026-11-03T15:00:00-05:00' },
    end: { dateTime: '2026-11-03T15:30:00-05:00' },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    attendees: [
      { email: 'ada@acme.dev', responseStatus: 'accepted', self: true, organizer: true },
      { email: 'sam@x.com', displayName: 'Sam', responseStatus: 'needsAction' },
      { email: 'kim@x.com', responseStatus: 'somethingNew' }
    ]
  }

  it('lists today and tomorrow in the calendar’s own time zone, one occurrence per repeat', async () => {
    const { api, fake } = await apiWith([
      primary,
      (url) =>
        url.pathname === `${CAL}/calendars/ada%40acme.dev/events`
          ? googleJson(200, { items: [event, { id: 'gone', status: 'cancelled' }] })
          : null
    ])
    const view = await listCalendarEvents(api, { now: NOW })
    const query = fake.calls[1]?.searchParams
    expect(query?.get('timeMin')).toBe('2026-11-03T00:00:00-05:00')
    expect(query?.get('timeMax')).toBe('2026-11-05T00:00:00-05:00')
    expect(query?.get('singleEvents')).toBe('true')
    expect(view.timeZone).toBe('America/New_York')
    expect(view.events).toEqual([
      expect.objectContaining({
        ref: 'calendar:ada@acme.dev:event:e1_20261103T200000Z',
        title: 'Design review',
        recurring: true,
        meetUrl: 'https://meet.google.com/abc-defg-hij',
        attendees: [
          expect.objectContaining({ email: 'ada@acme.dev', response: 'accepted' }),
          expect.objectContaining({ name: 'Sam', response: 'needsAction' }),
          expect.objectContaining({ email: 'kim@x.com', response: 'needsAction' })
        ]
      })
    ])
  })

  it('takes days in the calendar’s zone (the --to day included), picks a calendar by name, and refuses a bare time', async () => {
    const { api, fake } = await apiWith([
      (url) =>
        url.pathname === `${CAL}/users/me/calendarList`
          ? googleJson(200, {
              items: [
                { id: 'team@group.calendar.google.com', summary: 'Team', timeZone: 'Asia/Kolkata' }
              ]
            })
          : null,
      (url) => (url.pathname.endsWith('/events') ? googleJson(200, { items: [] }) : null)
    ])
    await listCalendarEvents(api, {
      now: NOW,
      calendar: 'team',
      from: '2026-11-09',
      to: '2026-11-13'
    })
    const query = fake.calls[1]?.searchParams
    expect(query?.get('timeMin')).toBe('2026-11-09T00:00:00+05:30')
    expect(query?.get('timeMax')).toBe('2026-11-14T00:00:00+05:30')
    await expect(
      listCalendarEvents(api, { now: NOW, calendar: 'team', from: 'next tuesday' })
    ).rejects.toThrow('--from takes a day')
    await expect(listCalendarEvents(api, { now: NOW, calendar: 'Nope' })).rejects.toThrow(
      'No calendar is named'
    )
  })

  it('gets one event in full from its ref, and lists calendars', async () => {
    const { api } = await apiWith([
      primary,
      (url) =>
        url.pathname === `${CAL}/users/me/calendarList/ada%40acme.dev`
          ? googleJson(200, { id: 'ada@acme.dev', summary: 'Ada', timeZone: 'America/New_York' })
          : null,
      (url) =>
        url.pathname === `${CAL}/calendars/ada%40acme.dev/events/e1_20261103T200000Z`
          ? googleJson(200, {
              ...event,
              description: 'Agenda: ship it',
              organizer: { email: 'ada@acme.dev' }
            })
          : null,
      (url) =>
        url.pathname.includes('/events/') ? googleJson(404, { error: { code: 404 } }) : null,
      (url) =>
        url.pathname === `${CAL}/users/me/calendarList`
          ? googleJson(200, {
              items: [
                { id: 'ada@acme.dev', summary: 'Ada', primary: true, timeZone: 'America/New_York' }
              ]
            })
          : null
    ])
    const view = await getCalendarEvent(api, {
      ref: 'calendar:ada@acme.dev:event:e1_20261103T200000Z',
      now: NOW
    })
    expect(view.event).toMatchObject({ description: 'Agenda: ship it', organizer: 'ada@acme.dev' })
    await expect(getCalendarEvent(api, { ref: 'missing1', now: NOW })).rejects.toThrow(
      'no such event'
    )
    expect((await listCalendars(api, NOW)).calendars).toEqual([
      { id: 'ada@acme.dev', name: 'Ada', primary: true, access: 'reader' }
    ])
  })
})

describe('Contacts find', () => {
  it('merges contacts, other contacts and the directory, once per email, and says what it could not search', async () => {
    const person = (name: string, email: string) => ({
      names: [{ displayName: name }],
      emailAddresses: [{ value: email }]
    })
    const { api, fake } = await apiWith([
      (url) =>
        url.pathname === '/v1/people:searchContacts'
          ? googleJson(
              200,
              url.searchParams.get('query')
                ? { results: [{ person: person('Sam Lee', 'Sam@x.com') }] }
                : {}
            )
          : null,
      (url) =>
        url.pathname === '/v1/otherContacts:search'
          ? googleJson(
              200,
              url.searchParams.get('query')
                ? {
                    results: [
                      { person: person('Sam', 'sam@x.com') },
                      { person: person('Sam Park', 'sam.park@y.com') }
                    ]
                  }
                : {}
            )
          : null,
      (url) =>
        url.pathname === '/v1/people:searchDirectoryPeople'
          ? googleJson(400, {
              error: { message: 'Must be a G Suite domain user.', status: 'FAILED_PRECONDITION' }
            })
          : null
    ])
    const view = await findContacts(api, 'sam')
    expect(view.people).toEqual([
      { name: 'Sam Lee', emails: ['sam@x.com'], source: 'contacts' },
      { name: 'Sam Park', emails: ['sam.park@y.com'], source: 'other' }
    ])
    expect(view.skipped).toEqual([
      { source: 'directory', reason: expect.stringContaining('G Suite') }
    ])
    // Each personal search is warmed up first, as Google asks.
    expect(
      fake.calls
        .filter((call) => call.pathname === '/v1/people:searchContacts')
        .map((call) => call.searchParams.get('query'))
    ).toEqual(['', 'sam'])
  })
})
