// teams.mentioned against Graph answers shaped like Microsoft's documented ones; no live tenant.
import { describe, expect, it } from 'vitest'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import { TeamsGraphError, type TeamsGraph } from './teams-graph'
import { messagesIn } from './teams-mention-reads'
import { TeamsTriggerChecker } from './teams-trigger-checker'
import type { TeamsTriggerState } from './teams-trigger-state'

const ME = '6e5b2c1a-0000-4000-8000-000000000001'
const DANA = '6e5b2c1a-0000-4000-8000-000000000002'
const RELEASE = '19:release0chat@thread.v2'
const QUIET = '19:quiet0chat@thread.v2'
const T0 = Date.parse('2026-11-25T18:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const message = (id: string, from: string, mentions: string[], created: number) => ({
  id,
  messageType: 'message',
  createdDateTime: iso(created),
  lastModifiedDateTime: iso(created),
  deletedDateTime: null,
  from: { user: { id: from, displayName: from === ME ? 'Me' : 'Dana Lee' }, application: null },
  body: {
    contentType: 'html',
    content: `<p><at id="0">Me</at> can you ship the release notes?</p>`
  },
  mentions: mentions.map((id, index) => ({
    id: index,
    mentionText: 'Me',
    mentioned: { user: { id, displayName: 'Me' } }
  })),
  webUrl: `https://teams.microsoft.com/l/message/${RELEASE}/${id}`
})

/** Graph as the checker reads it; a request for anything not listed fails the test. */
function graph(reads: string[]): TeamsGraph {
  const chats = {
    value: [
      {
        id: RELEASE,
        topic: 'Release',
        chatType: 'group',
        lastMessagePreview: { createdDateTime: iso(T0 + 40_000) }
      },
      {
        id: QUIET,
        topic: null,
        chatType: 'oneOnOne',
        lastMessagePreview: { createdDateTime: iso(T0 - 86_400_000) }
      }
    ],
    '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=never-read'
  }
  const messages = {
    value: [
      message('1732557640000', DANA, [], T0 + 40_000),
      message('1732557630000', ME, [ME], T0 + 30_000),
      message('1732557620000', DANA, [ME], T0 + 20_000),
      // Edited now, written long before the cursor: an old mention, not a new one.
      message('1732550000000', DANA, [ME], T0 - 3_600_000)
    ]
  }
  return {
    account: async () => ({ userId: ME, grantedScopes: ['Chat.Read'] }),
    post: () => Promise.reject(new Error('the check never posts')),
    get: async (path, shape) => {
      reads.push(path)
      if (path.startsWith('/me/chats?')) {
        return shape.parse(chats)
      }
      if (path.startsWith(`/chats/${encodeURIComponent(RELEASE)}/messages?`)) {
        return shape.parse(messages)
      }
      throw new Error(`unrecorded request: ${path}`)
    }
  }
}

describe('TeamsTriggerChecker', () => {
  it('starts a run for each new mention of the owner by someone else, once, and holds its place until the run starts', async () => {
    let state: TeamsTriggerState = { listeners: {} }
    let now = T0
    const reads: string[] = []
    const started: [string, AutomationRunEvent][] = []
    let refuse = true
    const rule = { id: 'on-1', source: 'teams' as const, event: 'mentioned' as const }
    const checker = new TeamsTriggerChecker({
      automations: () => [
        {
          id: 'a-on',
          enabled: true,
          bot: { botId: 'b-on', runsIn: 'new', resultsTo: 'chat' },
          on: [rule]
        },
        {
          id: 'a-off',
          enabled: true,
          bot: { botId: 'b-off', runsIn: 'new', resultsTo: 'chat' },
          on: [rule]
        },
        {
          id: 'a-elsewhere',
          enabled: true,
          bot: { botId: 'b-on', runsIn: 'new', resultsTo: 'chat' },
          on: [{ ...rule, id: 'on-2', in: [`teams:chat/${QUIET}`] }]
        }
      ],
      bots: () => [
        { id: 'b-on', teams: true },
        { id: 'b-off', teams: false }
      ],
      graph: () => graph(reads),
      runForEvent: async (automationId, event) => {
        if (refuse) {
          throw new Error('run path busy')
        }
        started.push([automationId, event])
      },
      readState: async () => structuredClone(state),
      writeState: async (next) => {
        state = next
      },
      now: () => now
    })

    // The first check only marks where listening began; nothing before it ever starts a run.
    await checker.tick()
    expect(reads).toEqual([])
    expect(state).toEqual({ userId: ME, cursor: T0, listeners: { 'b-on': T0 } })

    now = T0 + 60_000
    await checker.tick()
    expect(started).toEqual([])
    // The window the run path didn't take is kept, and offered again next check.
    expect(state.backlog).toEqual({
      [RELEASE]: { from: T0 - 120_000, until: T0 + 60_001, topic: 'Release' }
    })

    refuse = false
    await checker.tick()
    expect(started).toEqual([
      [
        'a-on',
        {
          triggerId: 'on-1',
          source: 'teams',
          event: 'mentioned',
          key: `teams:chat/${RELEASE}/1732557620000`,
          subject: `teams:chat/${RELEASE}`,
          occurredAt: T0 + 20_000,
          actor: 'Dana Lee',
          place: 'Release',
          url: `https://teams.microsoft.com/l/message/${RELEASE}/1732557620000`,
          text: '@Me can you ship the release notes?',
          teams: { ref: `teams:chat/${RELEASE}/1732557620000` }
        }
      ]
    ])
    expect(state.cursor).toBe(T0 + 60_000)
    expect(state.backlog).toBeUndefined()
    // The quiet chat had nothing new, and the page ended on it, so neither it nor a next page was read.
    expect(
      reads.every(
        (path) => !path.includes(encodeURIComponent(QUIET)) && !path.includes('skiptoken')
      )
    ).toBe(true)
  })

  it('reads on, at the next check, the part of a busy chat its page budget left unread', async () => {
    const reads: string[] = []
    const started: AutomationRunEvent[] = []
    let state: TeamsTriggerState = { userId: ME, cursor: T0, listeners: { 'b-on': T0 } }
    let now = T0 + 60_000
    // Every page of new messages links to another, so the budget always stops before the mention.
    const chatter = (n: number) => ({
      value: [message(`17325576${n}0000`, DANA, [], T0 + 50_000 - n * 1000)],
      '@odata.nextLink': `https://graph.microsoft.com/v1.0/chats/x/messages?$skiptoken=${n}`
    })
    const busy: TeamsGraph = {
      account: async () => ({ userId: ME, grantedScopes: ['Chat.Read'] }),
      post: () => Promise.reject(new Error('the check never posts')),
      get: async (path, shape) => {
        reads.push(path)
        if (path.startsWith('/me/chats?')) {
          return shape.parse({
            value: [
              {
                id: RELEASE,
                topic: 'Release',
                chatType: 'group',
                lastMessagePreview: { createdDateTime: iso(T0 + 50_000) }
              }
            ]
          })
        }
        if (path.includes('lastModifiedDateTime lt')) {
          return shape.parse({ value: [message('1732557620000', DANA, [ME], T0 + 20_000)] })
        }
        const n = path.includes('skiptoken=') ? Number(path.split('skiptoken=')[1]) + 1 : 1
        return shape.parse(chatter(n))
      }
    }
    const checker = new TeamsTriggerChecker({
      automations: () => [
        {
          id: 'a-on',
          enabled: true,
          bot: { botId: 'b-on', runsIn: 'new', resultsTo: 'chat' },
          on: [{ id: 'on-1', source: 'teams', event: 'mentioned' }]
        }
      ],
      bots: () => [{ id: 'b-on', teams: true }],
      graph: () => busy,
      runForEvent: async (_automationId, event) => {
        started.push(event)
      },
      readState: async () => structuredClone(state),
      writeState: async (next) => {
        state = next
      },
      now: () => now
    })

    await checker.tick()
    expect(started).toEqual([])
    expect(state.cursor).toBe(T0 + 60_000)
    expect(state.backlog?.[RELEASE]).toEqual({
      from: T0 - 120_000,
      until: T0 + 47_001,
      topic: 'Release'
    })

    now = T0 + 120_000
    await checker.tick()
    expect(started.map((event) => event.key)).toEqual([`teams:chat/${RELEASE}/1732557620000`])
    expect(reads.filter((path) => path.includes('lastModifiedDateTime lt'))).toEqual([
      `/chats/${encodeURIComponent(RELEASE)}/messages?$top=50&$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt ${iso(T0 - 120_000)} and lastModifiedDateTime lt ${iso(T0 + 47_001)}`
    ])
  })

  it('keeps every chat-list page a budget stopped at, and shrinks a window whose budget shares one change time', async () => {
    const reads: string[] = []
    let page = 0
    const endless: TeamsGraph = {
      account: async () => ({ userId: ME, grantedScopes: ['Chat.Read'] }),
      post: () => Promise.reject(new Error('the check never posts')),
      get: async (path, shape) => {
        reads.push(path)
        if (path.includes('/messages?')) {
          return shape.parse({
            value: [message(`1732557${page}`, DANA, [], T0 + 30_000)],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/chats/x/messages?$skiptoken=tie'
          })
        }
        page += 1
        return shape.parse({
          value: [
            {
              id: `19:chat${page}@thread.v2`,
              topic: null,
              chatType: 'group',
              lastMessagePreview: { createdDateTime: iso(T0 + 30_000) }
            }
          ],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/chats?$skiptoken=${page}`
        })
      }
    }

    // Graph lists by change time only, so a read whose whole budget shares one time reads before it.
    const tied = await messagesIn(endless, RELEASE, { from: T0, until: T0 + 30_001 })
    expect(tied.rest).toEqual({ from: T0, until: T0 + 30_000 })

    const resumedLink = 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=saved'
    let state: TeamsTriggerState = {
      userId: ME,
      cursor: T0,
      listeners: { 'b-on': T0 },
      chatsNext: [{ link: resumedLink, from: T0 - 180_000 }]
    }
    const checker = new TeamsTriggerChecker({
      automations: () => [
        {
          id: 'a-on',
          enabled: true,
          bot: { botId: 'b-on', runsIn: 'new', resultsTo: 'chat' },
          on: [{ id: 'on-1', source: 'teams', event: 'mentioned' }]
        }
      ],
      bots: () => [{ id: 'b-on', teams: true }],
      graph: () => endless,
      runForEvent: async () => {},
      readState: async () => structuredClone(state),
      writeState: async (next) => {
        state = next
      },
      now: () => T0 + 60_000
    })
    await checker.tick()
    expect(reads).toContain(resumedLink)
    // Both lists ran out of budget: the resumed one and the fresh one each keep their next page.
    expect(state.chatsNext).toEqual([
      { link: 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=4', from: T0 - 180_000 },
      { link: 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=8', from: T0 - 120_000 }
    ])
  })

  it('reads the rest of the backlog past a chat that fails, and keeps only what can still be read', async () => {
    const GONE = '19:gone0chat@thread.v2'
    const FLAKY = '19:flaky0chat@thread.v2'
    const started: string[] = []
    const window = { from: T0 - 60_000, until: T0 }
    let state: TeamsTriggerState = {
      userId: ME,
      cursor: T0,
      listeners: { 'b-on': T0 - 600_000 },
      backlog: {
        [GONE]: { ...window, topic: null },
        [FLAKY]: { ...window, topic: null },
        [RELEASE]: { ...window, topic: 'Release' }
      }
    }
    const reads: TeamsGraph = {
      account: async () => ({ userId: ME, grantedScopes: ['Chat.Read'] }),
      post: () => Promise.reject(new Error('the check never posts')),
      get: async (path, shape) => {
        if (path.startsWith('/me/chats?')) {
          return shape.parse({ value: [] })
        }
        if (path.includes(encodeURIComponent(GONE))) {
          throw new TeamsGraphError(404, 'Teams has no such chat, channel or message for you.')
        }
        if (path.includes(encodeURIComponent(FLAKY))) {
          throw new TeamsGraphError(502, 'Microsoft Graph answered 502.')
        }
        return shape.parse({ value: [message('1732557620000', DANA, [ME], T0 - 30_000)] })
      }
    }
    const checker = new TeamsTriggerChecker({
      automations: () => [
        {
          id: 'a-on',
          enabled: true,
          bot: { botId: 'b-on', runsIn: 'new', resultsTo: 'chat' },
          on: [{ id: 'on-1', source: 'teams', event: 'mentioned' }]
        }
      ],
      bots: () => [{ id: 'b-on', teams: true }],
      graph: () => reads,
      runForEvent: async (_automationId, event) => {
        started.push(event.key)
      },
      readState: async () => structuredClone(state),
      writeState: async (next) => {
        state = next
      },
      now: () => T0 + 60_000
    })
    await checker.tick()
    expect(started).toEqual([`teams:chat/${RELEASE}/1732557620000`])
    // The chat Teams says is gone is dropped; the one that failed for now is read again next check.
    expect(state.backlog).toEqual({ [FLAKY]: { ...window, topic: null } })
  })
})
