import { describe, expect, it, vi } from 'vitest'
import type { BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  BOT_CHAT_TAB_IDLE_MS,
  BOT_CHAT_TAB_TIDY_EVERY_MS,
  BOT_CHAT_TAB_TIDY_FIRST_AFTER_MS,
  BotChatTabTidyTicker,
  botChatTabHeld,
  botChatTabsDue,
  tidyBotChatTabs,
  type BotChatTabTidyHost,
  type BotChatTabTidyTab
} from './bot-chat-tab-tidy'

const NOW = 10 * BOT_CHAT_TAB_IDLE_MS
const OLD = NOW - BOT_CHAT_TAB_IDLE_MS - 1
const RECENT = NOW - BOT_CHAT_TAB_IDLE_MS + 60_000
const WORKSPACE = folderWorkspaceKey('home-folder')

function chat(chatId: string, overrides: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: OLD,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...overrides
  }
}

function tab(sessionId: string, overrides: Partial<BotChatTabTidyTab> = {}): BotChatTabTidyTab {
  return { sessionId, tabId: `tab-${sessionId}`, isActive: false, ...overrides }
}

function fakeHost(input: {
  chats: BotChatTreeChat[]
  tabs: BotChatTabTidyTab[]
  openItems?: string[]
  unsettled?: string[]
  focused?: Record<string, number>
  rootOf?: Record<string, string>
}): BotChatTabTidyHost & { closed: string[] } {
  const closed: string[] = []
  return {
    closed,
    bots: () => [{ id: 'bot-1', folderWorkspaceId: 'home-folder' }],
    chats: async () => ({
      chats: input.chats,
      rootOf: (sessionId) => input.rootOf?.[sessionId] ?? sessionId
    }),
    tabs: async (workspaceId) => (workspaceId === WORKSPACE ? input.tabs : []),
    openItemChats: async (_botId, chatIds) =>
      new Set(chatIds.filter((id) => input.openItems?.includes(id))),
    settled: (sessionIds) => !sessionIds.some((id) => input.unsettled?.includes(id)),
    lastFocusedAt: (_workspaceId, entry) => input.focused?.[entry.tabId] ?? null,
    closeTab: async (workspaceId, tabId) => {
      expect(workspaceId).toBe(WORKSPACE)
      closed.push(tabId)
    },
    now: () => NOW,
    warn: () => {}
  }
}

describe('botChatTabsDue', () => {
  it('takes a settled side or thread chat whose tab sat a day untouched, failed or not', () => {
    const due = botChatTabsDue(
      [
        chat('failed', { failedTotal: 2, finishedTotal: 2 }),
        chat('slack', { origin: 'slack' }),
        chat('exactly-a-day', { lastActiveAt: NOW - BOT_CHAT_TAB_IDLE_MS })
      ],
      NOW
    )
    expect(due.map((entry) => entry.chatId)).toEqual(['failed', 'slack', 'exactly-a-day'])
  })

  it('keeps Home, automation runs, group rooms, ended chats and chats with no tab', () => {
    const due = botChatTabsDue(
      [
        chat('home', { origin: 'home' }),
        chat('automation', { origin: 'automation' }),
        chat('run:1', { run: { automationId: 'a', runId: '1' } }),
        chat('ended', { closed: true }),
        chat('no-tab', { tab: false }),
        chat('older-host', { tab: undefined })
      ],
      NOW
    )
    expect(due).toEqual([])
  })

  it('keeps a chat that replies, waits on the owner, has a worker going, or was active within the day', () => {
    const due = botChatTabsDue(
      [
        chat('replying', { live: 'replying' }),
        chat('needs-you', { live: 'needs-you' }),
        chat('worker', { runningTotal: 1 }),
        chat('recent', { lastActiveAt: RECENT })
      ],
      NOW
    )
    expect(due).toEqual([])
  })
})

describe('botChatTabHeld', () => {
  it('holds a pinned tab, the tab in front, and one focused within the day', () => {
    expect(botChatTabHeld(tab('a', { isPinned: true }), null, NOW)).toBe(true)
    expect(botChatTabHeld(tab('a', { isActive: true }), null, NOW)).toBe(true)
    expect(botChatTabHeld(tab('a'), RECENT, NOW)).toBe(true)
    expect(botChatTabHeld(tab('a'), OLD, NOW)).toBe(false)
    expect(botChatTabHeld(tab('a'), null, NOW)).toBe(false)
  })
})

describe('tidyBotChatTabs', () => {
  it("closes a settled old chat's tab and nothing else", async () => {
    const host = fakeHost({
      chats: [chat('old'), chat('live', { live: 'replying' }), chat('home', { origin: 'home' })],
      tabs: [tab('old'), tab('live'), tab('home')]
    })
    expect(await tidyBotChatTabs(host)).toEqual(['old'])
    expect(host.closed).toEqual(['tab-old'])
  })

  it('keeps a chat that owns an open item', async () => {
    const host = fakeHost({ chats: [chat('owner')], tabs: [tab('owner')], openItems: ['owner'] })
    expect(await tidyBotChatTabs(host)).toEqual([])
    expect(host.closed).toEqual([])
  })

  it('keeps a pinned, front, or recently focused tab', async () => {
    const host = fakeHost({
      chats: [chat('pinned'), chat('front'), chat('focused')],
      tabs: [tab('pinned', { isPinned: true }), tab('front', { isActive: true }), tab('focused')],
      focused: { 'tab-focused': RECENT }
    })
    expect(await tidyBotChatTabs(host)).toEqual([])
  })

  it('keeps a chat that turned busy or is on a screen when the close comes, by any of its sessions', async () => {
    const host = fakeHost({
      chats: [chat('root', { liveSessionId: 'cleared' }), chat('viewed')],
      tabs: [tab('cleared'), tab('viewed')],
      rootOf: { cleared: 'root' },
      unsettled: ['cleared', 'viewed']
    })
    expect(await tidyBotChatTabs(host)).toEqual([])
  })

  it("closes a /clear'd chat's tab, found through its lineage", async () => {
    const host = fakeHost({
      chats: [chat('root', { liveSessionId: 'cleared' })],
      tabs: [tab('cleared')],
      rootOf: { cleared: 'root' }
    })
    expect(await tidyBotChatTabs(host)).toEqual(['root'])
    expect(host.closed).toEqual(['tab-cleared'])
  })

  it('goes on past a chat whose close fails and a bot whose read fails', async () => {
    const host = fakeHost({ chats: [chat('a'), chat('b')], tabs: [tab('a'), tab('b')] })
    const warn = vi.fn()
    let reads = 0
    const flaky: BotChatTabTidyHost = {
      ...host,
      warn,
      bots: () => [
        { id: 'broken', folderWorkspaceId: 'home-folder' },
        { id: 'bot-1', folderWorkspaceId: 'home-folder' }
      ],
      chats: async (botId) => {
        reads += 1
        if (botId === 'broken') {
          throw new Error('unreadable')
        }
        return host.chats(botId)
      },
      closeTab: async (workspaceId, tabId) => {
        if (tabId === 'tab-a') {
          throw new Error('refused')
        }
        await host.closeTab(workspaceId, tabId)
      }
    }
    expect(await tidyBotChatTabs(flaky)).toEqual(['b'])
    expect(reads).toBe(2)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('BotChatTabTidyTicker', () => {
  it('runs first a while after launch, then at most hourly, never two at once', async () => {
    let release: (closed: string[]) => void = () => {}
    const run = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve
        })
    )
    const host = fakeHost({ chats: [], tabs: [] })
    const ticker = new BotChatTabTidyTicker(() => ({ ...host, bots: () => (run(), []) }))
    const start = 1_000
    await ticker.tick(start)
    await ticker.tick(start + BOT_CHAT_TAB_TIDY_FIRST_AFTER_MS - 1)
    expect(run).not.toHaveBeenCalled()
    await ticker.tick(start + BOT_CHAT_TAB_TIDY_FIRST_AFTER_MS)
    expect(run).toHaveBeenCalledTimes(1)
    await ticker.tick(start + BOT_CHAT_TAB_TIDY_FIRST_AFTER_MS + BOT_CHAT_TAB_TIDY_EVERY_MS - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await ticker.tick(start + BOT_CHAT_TAB_TIDY_FIRST_AFTER_MS + BOT_CHAT_TAB_TIDY_EVERY_MS)
    expect(run).toHaveBeenCalledTimes(2)
    release([])
  })
})
