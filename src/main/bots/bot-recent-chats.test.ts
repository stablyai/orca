import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { readBotChats } from '../runtime/rpc/methods/bots-chats'
import { requireStructuredHost } from './bot-chat-session'
import { readSharedBotChatTree } from './bot-chat-tree-host'
import {
  botRecentChatsSection,
  type BotRecentChat,
  readBotRecentChats,
  visibleBotRecentChats
} from './bot-recent-chats'

vi.mock('../runtime/rpc/methods/bots-chats', () => ({ readBotChats: vi.fn() }))
vi.mock('./bot-chat-session', () => ({ requireStructuredHost: vi.fn() }))
vi.mock('./bot-chat-tree-host', () => ({ readSharedBotChatTree: vi.fn() }))

const NOW = Date.UTC(2026, 10, 12, 12)
const HOUR = 60 * 60 * 1000
const OWNER: BotRequestAsker[] = [{ kind: 'owner' }]
const person = (userId: string, role: 'owner' | 'member' = 'member'): BotRequestAsker => ({
  kind: 'person',
  source: 'slack',
  userId,
  workspaceId: 'T1',
  role
})

function chat(id: string, hoursAgo: number, actsFor: BotRequestAsker[] | null): BotRecentChat {
  return {
    id,
    title: id,
    lastActivityAt: NOW - hoursAgo * HOUR,
    lastSaid: null,
    actsFor,
    workers: [],
    self: false
  }
}

const ids = (chats: readonly BotRecentChat[]) => chats.map((entry) => entry.id)

describe("which of a bot's other chats a turn hears of", () => {
  const chats = [
    chat('owner-home', 1, OWNER),
    chat('sam-thread', 2, [person('U0SAM')]),
    chat('dana-thread', 3, [person('U0DANA')]),
    chat('unrecorded', 4, null),
    chat('stale', 49, OWNER),
    { ...chat('this-chat', 0, OWNER), self: true }
  ]

  it("the owner's turn hears of every chat active in the last 48 h but its own, newest first", () => {
    expect(ids(visibleBotRecentChats(OWNER, chats, NOW))).toEqual([
      'owner-home',
      'sam-thread',
      'dana-thread',
      'unrecorded'
    ])
  })

  it("a teammate's turn hears only of chats acting for that same person", () => {
    expect(ids(visibleBotRecentChats([person('U0SAM')], chats, NOW))).toEqual(['sam-thread'])
  })

  it('a turn for several people, or for anyone unknown, hears of none', () => {
    expect(visibleBotRecentChats([person('U0SAM'), person('U0DANA')], chats, NOW)).toEqual([])
    expect(visibleBotRecentChats([{ kind: 'unknown' }], chats, NOW)).toEqual([])
    expect(visibleBotRecentChats([...OWNER, { kind: 'unknown' }], chats, NOW)).toEqual([])
  })

  it('lists at most ten', () => {
    const many = Array.from({ length: 12 }, (_, index) => chat(`c${index}`, index, OWNER))
    expect(ids(visibleBotRecentChats(OWNER, many, NOW))).toEqual(
      Array.from({ length: 10 }, (_, index) => `c${index}`)
    )
  })
})

describe("the other chats' section", () => {
  it('gives each chat one line: its id, title, last reply cut to 150 characters and running workers', () => {
    const section = botRecentChatsSection(
      'ux-designer',
      [
        {
          ...chat('s-home', 2, OWNER),
          title: 'Pricing page',
          lastSaid: `Going with the paid tier. ${'x'.repeat(200)}`,
          workers: ['Build pricing page']
        }
      ],
      NOW
    )
    expect(section?.text).toContain('orchestration send --to bot:ux-designer --chat <id>')
    expect(section?.text.split('\n').slice(1)).toEqual([
      '<<<',
      `chat:s-home  "Pricing page"  2h ago  last reply: "Going with the paid tier. ${'x'.repeat(124)}"  worker running: "Build pricing page"`,
      '>>>'
    ])
  })

  it('keys on what the chats say, not how long ago, and is null with no chat', () => {
    const at = (now: number) => botRecentChatsSection('scout', [chat('a', 1, OWNER)], now)?.key
    expect(at(NOW)).toBe(at(NOW + HOUR))
    expect(botRecentChatsSection('scout', [], NOW)).toBeNull()
  })
})

describe('the other chats a turn of a real chat is told of', () => {
  const OTHER: BotChatRow = {
    id: 'other',
    title: 'Pricing',
    lastActivityAt: NOW - HOUR,
    lastAsked: null,
    lastSaid: 'Going with the paid tier.',
    home: false,
    self: false,
    closed: false
  }
  const SAM = person('U0SAM')
  const records = new Map<string, { actsFor: BotRequestAsker[] }>()
  const journalReads = vi.fn(async () => ({}))
  const runtime = {
    bots: { list: () => [{ id: 'bot-1', name: 'scout' }] },
    getOrchestrationDb: () => ({
      getBotConversationActsFor: (id: string) => records.get(id),
      getBotRequest: () => undefined
    }),
    // The current chat answers a Slack thread in workspace T1.
    getExternalConversationSeam: () => ({
      replyTarget: () => ({ key: { source: 'slack', externalId: 'T1:C9:1.2:UBOT' } })
    })
  }
  vi.mocked(requireStructuredHost).mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the turn read uses only journalReads.
    { journalReads } as never
  )
  vi.mocked(readBotChats).mockResolvedValue([OTHER])
  vi.mocked(readSharedBotChatTree).mockResolvedValue({ chats: [], workspaceChats: {} })
  const read = (message: AgentJournalMessageItem) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies what the read uses.
    readBotRecentChats(runtime as never, 'bot-1', 'current', message, NOW)
  const fromSlack = (asker?: AgentJournalMessageItem['asker']): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'which tier?' }],
    origin: 'connector',
    ...(asker ? { asker } : {})
  })

  it("tells an unstamped connector message none of the owner's chats, in an owner's thread", async () => {
    records.set('current', { actsFor: OWNER })
    records.set('other', { actsFor: OWNER })
    expect(await read(fromSlack())).toBeNull()
  })

  it("tells a teammate stamped on the message their own chats, as the thread's record names them", async () => {
    records.set('current', { actsFor: [SAM] })
    records.set('other', { actsFor: [SAM] })
    const section = await read(
      fromSlack({
        source: 'slack',
        userId: 'U0SAM',
        role: 'member',
        place: { kind: 'public_channel', id: 'C9' }
      })
    )
    expect(section?.text).toContain('chat:other')
  })

  it("reads the turn from the message and the record, never the chat's whole journal", async () => {
    records.set('current', { actsFor: OWNER })
    records.set('other', { actsFor: OWNER })
    journalReads.mockClear()
    const owner: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'what did we decide?' }]
    }
    expect((await read(owner))?.text).toContain('chat:other')
    expect(journalReads).not.toHaveBeenCalled()
  })
})
