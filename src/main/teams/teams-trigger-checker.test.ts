// teams.mentioned against Graph answers shaped like Microsoft's documented ones; no live tenant.
import { describe, expect, it } from 'vitest'
import type { AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { TeamsGraph } from './teams-graph'
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
    expect(state.cursor).toBe(T0)

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
    // The quiet chat had nothing new, and the page ended on it, so neither it nor a next page was read.
    expect(
      reads.every(
        (path) => !path.includes(encodeURIComponent(QUIET)) && !path.includes('skiptoken')
      )
    ).toBe(true)
  })
})
