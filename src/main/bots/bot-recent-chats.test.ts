import { describe, expect, it, vi } from 'vitest'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { readBotChats } from '../runtime/rpc/methods/bots-chats'
import { readSharedBotChatTree } from './bot-chat-tree-host'
import {
  botRecentChatsSection,
  type BotRecentChat,
  readBotRecentChats,
  visibleBotRecentChats
} from './bot-recent-chats'

vi.mock('../runtime/rpc/methods/bots-chats', () => ({ readBotChats: vi.fn() }))
vi.mock('./bot-chat-tree-host', () => ({ readSharedBotChatTree: vi.fn() }))

const NOW = Date.UTC(2026, 10, 12, 12)
const HOUR = 60 * 60 * 1000

function chat(id: string, hoursAgo: number): BotRecentChat {
  return {
    id,
    title: id,
    lastActivityAt: NOW - hoursAgo * HOUR,
    lastSaid: null,
    workers: [],
    self: false
  }
}

const ids = (chats: readonly BotRecentChat[]) => chats.map((entry) => entry.id)

describe("which of a bot's other chats a turn hears of", () => {
  it('every chat active in the last 48 h but its own, newest first', () => {
    const chats = [
      chat('dana-thread', 3),
      chat('owner-home', 1),
      chat('stale', 49),
      { ...chat('this-chat', 0), self: true }
    ]
    expect(ids(visibleBotRecentChats(chats, NOW))).toEqual(['owner-home', 'dana-thread'])
  })
})

describe("the other chats' section", () => {
  it('fences chat context and points to the command that can ask the chat', () => {
    const section = botRecentChatsSection(
      'ux-designer',
      [
        {
          ...chat('s-home', 2),
          title: 'Pricing page',
          lastSaid: `Going with the paid tier. ${'x'.repeat(200)}`,
          workers: ['Build pricing page']
        }
      ],
      NOW
    )
    expect(section?.text).toContain('orchestration send --to bot:ux-designer --chat <id>')
    const [, opening, context, closing] = section?.text.split('\n') ?? []
    expect(opening).toBe('<<<')
    expect(context).toContain('chat:s-home')
    expect(context).toContain('Pricing page')
    expect(context).toContain('Going with the paid tier.')
    expect(context).toContain('Build pricing page')
    expect(closing).toBe('>>>')
  })

  it('keys on what the chats say, not how long ago, and is null with no chat', () => {
    const at = (now: number) => botRecentChatsSection('scout', [chat('a', 1)], now)?.key
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
  const runtime = { bots: { list: () => [{ id: 'bot-1', name: 'scout' }] } }
  vi.mocked(readBotChats).mockResolvedValue([OTHER])
  vi.mocked(readSharedBotChatTree).mockResolvedValue({ chats: [], workspaceChats: {} })

  it("tells a teammate's turn of the owner's other chats", async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub supplies what the read uses.
    const section = await readBotRecentChats(runtime as never, 'bot-1', 'dana-thread', NOW)
    expect(section?.text).toContain('chat:other')
  })
})
