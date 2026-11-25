import { describe, expect, it } from 'vitest'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import type { BotItemLinkView } from '../../shared/bots/bot-items'
import { botActiveWorkSection, botIdleItemsNote } from './bot-active-work'
import { botNeedsYouInChatNote } from './bot-unanswered-question-note'
import { createCanonicalSessionResolver } from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'

const worker = (state: 'working' | 'unknown' | 'completed'): BotItemLinkView => ({
  kind: 'dispatch',
  ref: `ctx_${state}`,
  latest: null,
  title: 'Fix it',
  state,
  host: null,
  startedAt: 0,
  settledAt: null,
  report: null,
  pr: null
})

describe('an In progress item nothing runs for', () => {
  it('is idle with no live worker and no active wait, and not with either', () => {
    const items = [
      makeTestBotItem(1),
      makeTestBotItem(2, { links: [worker('completed')] }),
      makeTestBotItem(3, {
        links: [{ kind: 'automation', ref: 'a1', name: 'CI', active: false }]
      }),
      makeTestBotItem(4, { links: [worker('unknown')] }),
      makeTestBotItem(5, { links: [{ kind: 'automation', ref: 'a2', name: 'CI', active: true }] })
    ]
    const section = botActiveWorkSection(items, [])
    expect(section.idle?.map((item) => item.number)).toEqual([1, 2, 3])
    expect(section.text).not.toContain('nothing is running')
  })

  it('keeps work as context everywhere and prompts only its owning chat, including after a clear', () => {
    const memo = new Map<string, Map<number, string>>()
    const owner = { id: 'rail', kind: 'thread', title: 'Rail redesign' } as const
    const item = makeTestBotItem(7, { chat: owner })
    const next = 'rail-after-clear'
    const record = (sessionId: string) =>
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
    const records = new Map([
      [
        owner.id,
        agentSessionConversationView({
          ...record(owner.id),
          conversationCommand: {
            command: 'clear',
            phase: 'committed',
            state: 'completed',
            callerKey: owner.id,
            operationId: 'clear-rail',
            replacementSessionId: next
          }
        })
      ],
      [next, agentSessionConversationView(record(next))]
    ])
    const sessionForChat = createCanonicalSessionResolver({
      getRecord: (id) => records.get(id) ?? null,
      listRecords: () => {
        throw new Error('idle notes must not enumerate chat records')
      }
    })
    const say = (sessionId: string, items: readonly (typeof item)[]) => {
      const work = botActiveWorkSection(items, [])
      const note = botIdleItemsNote(memo, sessionId, work.idle ?? [], sessionForChat)
      note?.given()
      return { context: work.text, action: note?.text ?? null }
    }
    expect(say('pr-chat', [item])).toMatchObject({
      context: expect.stringContaining('#7 in progress'),
      action: null
    })
    expect(say('chat-home', [item]).action).toBeNull()
    expect(say(owner.id, [item]).action).toBeNull()
    expect(say(next, [item]).action).toContain('Item 7 is In progress')
    expect(say(next, [item]).action).toBeNull()
    expect(say(next, [{ ...item, lastEventId: 'e11' }]).action).toContain('--expected-version')
    expect(say(next, [{ ...item, status: 'done', lastEventId: 'e12' }]).action).toBeNull()
    expect(
      say(next, [{ ...item, chat: { ...owner, gone: true }, lastEventId: 'e13' }]).action
    ).toBeNull()
  })

  it('is said again when the turn that had it never delivered it', () => {
    const memo = new Map<string, Map<number, string>>()
    const idle7 = [{ number: 7, key: 'e10', chatId: 'chat' }]
    const sessionForChat = createCanonicalSessionResolver(null)
    expect(botIdleItemsNote(memo, 'chat', idle7, sessionForChat)?.text).toContain('Item 7')
    expect(botIdleItemsNote(memo, 'chat', idle7, sessionForChat)?.text).toContain('Item 7')
  })
})

describe('an owner chat whose own items are in Needs you', () => {
  const asking = (number: number, chatId: string, lastEventId = 'e10') =>
    makeTestBotItem(number, {
      status: 'needs_you',
      chat: { id: chatId, kind: 'home', title: null },
      lastEventId,
      question: {
        eventId: lastEventId,
        text: 'Context',
        gist: 'Context',
        decisions: [{ question: 'Ship on Friday?', replies: [] }]
      }
    })

  it('is told its own asks, once until they change, so an answer in chat can clear them', () => {
    const memo = new Map<string, string>()
    const say = (items: ReturnType<typeof asking>[]) => {
      const note = botNeedsYouInChatNote(
        memo,
        'chat-home',
        botActiveWorkSection(items, []).needsYou!
      )
      note?.given()
      return note?.text ?? null
    }
    const text = say([asking(4, 'chat-home'), asking(5, 'chat-side')])
    expect(text).toContain('#4 "Item 4" asks: "Ship on Friday?"')
    expect(text).toContain('--status in-progress --comment "You said in chat:')
    expect(text).not.toContain('#5')
    expect(say([asking(4, 'chat-home'), asking(5, 'chat-side')])).toBeNull()
    expect(say([asking(4, 'chat-home', 'e11')])).toContain('#4')
    expect(say([asking(5, 'chat-side')])).toBeNull()
  })
})
