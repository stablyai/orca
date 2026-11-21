import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { AutomationGoogleTrigger } from '../../shared/automation-google-triggers'
import {
  connectedGoogle,
  fakeGoogle,
  googleJson,
  NOW,
  type FakeRoute
} from './google-api.test-fixture'
import type { GoogleTriggerState } from './google-trigger-state'

let cleanup = (): void => {}
afterEach(() => cleanup())

const GMAIL = '/gmail/v1/users/me'
const EVENTS = '/calendar/v3/calendars/primary/events'

const gmailRule: AutomationGoogleTrigger = {
  id: 'on-mail',
  source: 'gmail',
  event: 'new_email',
  from: ['acme.com']
}
const calendarRule: AutomationGoogleTrigger = {
  id: 'on-meet',
  source: 'calendar',
  event: 'starting_soon',
  minutesBefore: 10
}

async function checkerWith(
  routes: FakeRoute[],
  options: {
    rules?: AutomationGoogleTrigger[]
    google?: boolean
    accounts?: string[]
    state?: GoogleTriggerState
    /** Fails this many run starts first, as a busy runtime would. */
    failRuns?: number
  } = {}
) {
  const accounts = options.accounts ?? ['ada@acme.dev']
  const google = await connectedGoogle(accounts)
  cleanup = google.cleanup
  const fake = fakeGoogle(routes)
  // From the same fresh modules as the client, so its errors are this checker's GoogleToolError.
  const { GoogleTriggerChecker } = await import('./google-trigger-checker')
  const fired: { automationId: string; event: AutomationRunEvent }[] = []
  let state: GoogleTriggerState = options.state ?? { accounts: {}, listeners: {} }
  let now = NOW
  let failRuns = options.failRuns ?? 0
  const checker = new GoogleTriggerChecker({
    automations: () => [
      {
        id: 'auto-1',
        enabled: true,
        bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
        on: options.rules ?? [gmailRule]
      }
    ],
    bots: () => [{ id: 'bot-1', google: options.google ?? true }],
    accounts: () => accounts,
    api: (account) => google.client.googleApi(account, { http: fake.http, now: () => now }),
    runForEvent: async (automationId, event) => {
      if ((failRuns -= 1) >= 0) {
        throw new Error('runtime_unavailable')
      }
      fired.push({ automationId, event })
    },
    readState: () => structuredClone(state),
    writeState: (next) => {
      state = next
    },
    now: () => now,
    tickMs: 60_000,
    setTimer: () => setTimeout(() => {}, 0),
    clearTimer: (timer) => clearTimeout(timer)
  })
  return {
    checker,
    fake,
    fired,
    state: () => state,
    advance: (ms: number) => {
      now += ms
    }
  }
}

const authResults = (verdict: string, domain = 'acme.com') =>
  `mx.google.com; spf=pass smtp.mailfrom=${domain}; dmarc=${verdict} (p=REJECT) header.from=${domain}`

function message(
  id: string,
  options: { from?: string; labels?: string[]; auth?: string[]; at?: number } = {}
) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: options.labels ?? ['INBOX', 'UNREAD'],
    snippet: 'Can you send the invoice?',
    internalDate: String(options.at ?? NOW + 30_000),
    payload: {
      headers: [
        ...(options.auth ?? [authResults('pass')]).map((value) => ({
          name: 'Authentication-Results',
          value
        })),
        { name: 'From', value: options.from ?? 'Sam Lee <sam@acme.com>' },
        { name: 'To', value: 'ada@acme.dev' },
        { name: 'Subject', value: 'Invoice' }
      ]
    }
  }
}

function gmailRoutes(added: ReturnType<typeof message>[], historyStatus = 200): FakeRoute[] {
  return [
    (url) => (url.pathname === `${GMAIL}/profile` ? googleJson(200, { historyId: '100' }) : null),
    (url) =>
      url.pathname === `${GMAIL}/history`
        ? historyStatus === 200
          ? googleJson(200, {
              historyId: '120',
              history: added.map((entry) => ({
                messagesAdded: [
                  { message: { id: entry.id, threadId: entry.threadId, labelIds: entry.labelIds } }
                ]
              }))
            })
          : googleJson(historyStatus, { error: { code: historyStatus } })
        : null,
    (url) => {
      const found = added.find((entry) => url.pathname === `${GMAIL}/messages/${entry.id}`)
      return found ? googleJson(200, found) : null
    }
  ]
}

describe('Gmail rules', () => {
  it('seeds Gmail history and fires only for the new message with an authenticated sender', async () => {
    const forged = message('m2', { auth: [authResults('fail')] })
    const planted = message('m3', {
      auth: ['mx.example.com; dmarc=fail', authResults('pass')]
    })
    const sent = message('m4', { labels: ['SENT'] })
    const old = message('m5', { at: NOW - 60_000 })
    const { checker, fired, state, fake } = await checkerWith(
      gmailRoutes([forged, planted, sent, old, message('m1')])
    )
    await checker.tick()
    expect(fired).toEqual([])
    expect(state().accounts['ada@acme.dev']?.historyId).toBe('100')
    expect(state().listeners['bot-1 ada@acme.dev']).toBe(NOW)
    await checker.tick()
    expect(fired).toHaveLength(1)
    expect(fired[0]?.event).toMatchObject({
      triggerId: 'on-mail',
      source: 'gmail',
      event: 'new_email',
      key: 'gmail:ada@acme.dev:m1',
      subject: 'gmail:ada@acme.dev:thread:t-m1',
      actor: 'Sam Lee <sam@acme.com>',
      text: 'Subject: Invoice\nCan you send the invoice?',
      google: { account: 'ada@acme.dev', ref: 'gmail:thread:t-m1' }
    })
    expect(state().accounts['ada@acme.dev']?.historyId).toBe('120')
    const read = fake.calls.find((call) => call.pathname === `${GMAIL}/messages/m1`)
    expect(read?.searchParams.get('format')).toBe('metadata')
  })

  it('backs off after a label rate limit and retries from the same history point after failures', async () => {
    let labelsUp = false
    const routes: FakeRoute[] = [
      (url) =>
        url.pathname === `${GMAIL}/labels`
          ? labelsUp
            ? googleJson(200, { labels: [{ id: 'Label_7', name: 'Clients' }] })
            : googleJson(429, { error: { code: 429 } })
          : null,
      ...gmailRoutes([message('m1', { labels: ['INBOX', 'Label_7'] })])
    ]
    const { checker, fake, fired, state, advance } = await checkerWith(routes, {
      rules: [{ ...gmailRule, label: 'clients' }],
      state: { accounts: { 'ada@acme.dev': { historyId: '7' } }, listeners: {} },
      failRuns: 1
    })
    await checker.tick()
    expect(state().accounts['ada@acme.dev']?.historyId).toBe('7')
    const calls = fake.calls.length
    labelsUp = true
    advance(30_000)
    await checker.tick()
    expect(fake.calls).toHaveLength(calls)

    advance(90_000)
    await checker.tick()
    expect(fake.calls.length).toBeGreaterThan(calls)
    expect(fired).toEqual([])
    expect(state().accounts['ada@acme.dev']?.historyId).toBe('7')
    await checker.tick()
    expect(fired.map((entry) => entry.event.key)).toEqual(['gmail:ada@acme.dev:m1'])
    expect(state().accounts['ada@acme.dev']?.historyId).toBe('120')
  })

  it('starts again from now when Gmail no longer has the saved history point', async () => {
    const { checker, fired, state } = await checkerWith(gmailRoutes([message('m1')], 404), {
      state: { accounts: { 'ada@acme.dev': { historyId: '7' } }, listeners: {} }
    })
    await checker.tick()
    expect(fired).toEqual([])
    expect(state().accounts['ada@acme.dev']?.historyId).toBe('100')
  })

  it('checks nothing for a bot whose owner has not turned Google on, or a rule naming no account among several', async () => {
    const off = await checkerWith(gmailRoutes([message('m1')]), { google: false })
    await off.checker.tick()
    expect(off.fake.calls).toEqual([])
    cleanup()
    const several = await checkerWith(gmailRoutes([message('m1')]), {
      accounts: ['ada@acme.dev', 'ada@gmail.com']
    })
    await several.checker.tick()
    expect(several.fake.calls).toEqual([])
    expect(several.state().listeners).toEqual({})
  })
})

function calendarRoutes(
  events: { id: string; startsIn: number; declined?: boolean }[],
  syncStatus = 200
): FakeRoute[] {
  let seeds = 0
  return [
    (url) => {
      if (url.pathname !== EVENTS) {
        return null
      }
      if (url.searchParams.has('fields')) {
        return url.searchParams.has('syncToken') && syncStatus !== 200
          ? googleJson(syncStatus, { error: { code: syncStatus } })
          : googleJson(200, { items: [], nextSyncToken: `sync-${++seeds}` })
      }
      return googleJson(200, {
        items: events.map((event) => ({
          id: event.id,
          summary: 'Design review',
          start: { dateTime: new Date(NOW + event.startsIn).toISOString() },
          end: { dateTime: new Date(NOW + event.startsIn + 1_800_000).toISOString() },
          attendees: [
            {
              email: 'ada@acme.dev',
              self: true,
              responseStatus: event.declined ? 'declined' : 'accepted'
            }
          ]
        }))
      })
    }
  ]
}

describe('Calendar rules', () => {
  it('fires once for a due meeting even if Calendar expires the sync token', async () => {
    const { checker, fake, fired, state } = await checkerWith(
      calendarRoutes(
        [
          { id: 'soon', startsIn: 5 * 60_000 },
          { id: 'later', startsIn: 3 * 3_600_000 },
          { id: 'declined', startsIn: 4 * 60_000, declined: true }
        ],
        410
      ),
      { rules: [calendarRule] }
    )
    await checker.tick()
    expect(state().accounts['ada@acme.dev']?.calendars?.primary?.syncToken).toBe('sync-1')
    await checker.tick()
    expect(fired.map((entry) => entry.event.google?.ref)).toEqual(['calendar:primary:event:soon'])
    expect(fired[0]?.event).toMatchObject({
      source: 'calendar',
      event: 'starting_soon',
      occurredAt: NOW + 5 * 60_000 - 10 * 60_000
    })
    expect(fake.calls.some((call) => call.searchParams.get('syncToken') === 'sync-1')).toBe(true)
    expect(state().accounts['ada@acme.dev']?.calendars?.primary?.syncToken).toBe('sync-2')
  })
})
