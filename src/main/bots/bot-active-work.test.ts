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
import { createBotIdleItemChatRouter } from './bot-idle-item-chat'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

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

  it('prompts the live owner or Home once while work stays visible across chats', () => {
    const memo = new Map<string, Map<number, string>>()
    const owner = { id: 'rail-chat', kind: 'thread', title: 'Rail redesign' } as const
    const item = makeTestBotItem(7, { chat: owner })
    const next = 'rail-after-clear'
    const bot = { folderWorkspaceId: 'designer', chatSessionId: 'home-chat' }
    const record = (sessionId: string) => {
      const base = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
      return {
        ...base,
        location: { ...base.location, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) }
      }
    }
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
      [next, agentSessionConversationView(record(next))],
      [bot.chatSessionId, agentSessionConversationView(record(bot.chatSessionId))]
    ])
    const revision = {}
    const retired = new Set<string>()
    const unavailable = new Set<string>()
    const background = new Set<string>()
    const read = {
      getRecord: (id: string) => records.get(id) ?? null,
      isSessionUnreadable: (id: string) => unavailable.has(id),
      isSessionTabRetired: (id: string) => retired.has(id),
      isSessionInBackground: (id: string) => background.has(id),
      lineageRevision: () => revision,
      listRecords: () => {
        throw new Error('idle notes must not enumerate chat records')
      }
    }
    const route = createBotIdleItemChatRouter()
    const say = (sessionId: string, items: readonly (typeof item)[] = [item]) => {
      const work = botActiveWorkSection(items, [])
      const idle = work.idle ?? []
      const note = botIdleItemsNote(memo, sessionId, idle, route(bot, read, sessionId, idle))
      note?.given()
      return { context: work.text, action: note?.text ?? null }
    }
    expect(say('pr-review-chat')).toMatchObject({
      context: expect.stringContaining('#7 in progress'),
      action: null
    })
    expect(say(bot.chatSessionId).action).toBeNull()
    expect(say(owner.id).action).toBeNull()
    expect(say(next).action).toContain('Item 7 is In progress')
    const revised = [{ ...item, lastEventId: 'e11' }]
    retired.add(next)
    background.add(next)
    expect(say(bot.chatSessionId, revised).action).toBeNull()
    background.delete(next)
    expect(say('pr-review-chat', revised).action).toBeNull()
    expect(say(bot.chatSessionId, revised).action).toContain('--expected-version')
    expect(say(bot.chatSessionId, revised).action).toBeNull()
    retired.delete(next)
    expect(say(next, revised).action).toContain('Item 7 is In progress')
    expect(say(next, [{ ...item, status: 'done', lastEventId: 'e12' }]).action).toBeNull()

    const missingId = 'deleted-chat'
    const gone = [{ ...item, chat: { ...owner, id: missingId, gone: true }, lastEventId: 'e13' }]
    unavailable.add(missingId)
    expect(say(bot.chatSessionId, gone).action).toBeNull()
    const assemble = () => say(bot.chatSessionId, gone).action
    unavailable.delete(missingId)
    records.set(missingId, agentSessionConversationView(record(missingId)))
    expect(assemble()).toBeNull()
    expect(say(missingId, gone).action).toContain('Item 7 is In progress')

    records.delete(missingId)
    expect(say('pr-review-chat', gone).action).toBeNull()
    expect(say(bot.chatSessionId, gone).action).toContain('Item 7 is In progress')
    const moved = record(next)
    records.set(
      next,
      agentSessionConversationView({
        ...moved,
        location: { ...moved.location, workspaceId: folderWorkspaceKey('another-folder') }
      })
    )
    retired.add(next)
    expect(say(bot.chatSessionId, [{ ...item, lastEventId: 'e14' }]).action).toBeNull()
    records.delete(next)
    expect(say(bot.chatSessionId, [{ ...item, lastEventId: 'e15' }]).action).toBeNull()
  })

  it('is said again when the turn that had it never delivered it', () => {
    const memo = new Map<string, Map<number, string>>()
    const idle7 = [{ number: 7, key: 'e10', chatId: 'chat' }]
    const sessionForChat = (id: string) => id
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
