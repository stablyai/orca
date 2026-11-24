import { describe, expect, it, vi } from 'vitest'
import type { BotChatTreeChat } from '../../shared/bots/bot-chat-tree'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import {
  BOT_CHAT_TAB_IDLE_MS,
  BOT_CHAT_TAB_TIDY_EVERY_MS,
  BOT_CHAT_TAB_TIDY_SOON_MS,
  BotChatTabTidyTicker,
  botChatTabHeld,
  botChatTabsDue,
  tidyBotChatTabs,
  type BotChatTabAdmission,
  type BotChatTabCloseOutcome,
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

type FakeInput = {
  chats: BotChatTreeChat[]
  tabs: BotChatTabTidyTab[]
  admissions?: Record<string, Partial<BotChatTabAdmission>>
  restartHeld?: string[]
  unsettled?: string[]
  focused?: Record<string, number>
  rootOf?: Record<string, string>
  outcomes?: Record<string, BotChatTabCloseOutcome>
  /** Tabs that turn up (or change) between the pass's first and fresh reads. */
  laterTabs?: BotChatTabTidyTab[]
}

type FakeHost = BotChatTabTidyHost & {
  closed: string[]
  notices: string[][]
  admissionCalls: string[]
}

function fakeHost(input: FakeInput): FakeHost {
  const closed: string[] = []
  const notices: string[][] = []
  const admissionCalls: string[] = []
  let reads = 0
  return {
    closed,
    notices,
    admissionCalls,
    bots: () => [{ id: 'bot-1', folderWorkspaceId: 'home-folder' }],
    chats: async () => ({
      chats: input.chats,
      rootOf: (sessionId) => input.rootOf?.[sessionId] ?? sessionId
    }),
    tabs: async (workspaceId) => {
      reads += 1
      const base = reads > 1 && input.laterTabs ? input.laterTabs : input.tabs
      return workspaceId === WORKSPACE ? base.filter((entry) => !closed.includes(entry.tabId)) : []
    },
    admission: async (_botId, chatId) => {
      admissionCalls.push(chatId)
      return { requestChat: true, holds: [], lastMailAt: null, ...input.admissions?.[chatId] }
    },
    restartHeld: async () => new Set(input.restartHeld ?? []),
    settled: (sessionIds) => !sessionIds.some((id) => input.unsettled?.includes(id)),
    lastFocusedAt: (_workspaceId, entry) => input.focused?.[entry.tabId] ?? null,
    closeTab: async (workspaceId, entry) => {
      expect(workspaceId).toBe(WORKSPACE)
      const outcome = input.outcomes?.[entry.tabId] ?? 'closed'
      if (outcome !== 'refused') {
        closed.push(entry.tabId)
      }
      return outcome
    },
    changed: (botIds) => notices.push([...botIds]),
    pause: async () => {},
    now: () => NOW,
    warn: () => {}
  }
}

describe('botChatTabsDue', () => {
  it('takes settled side chats with no turn for a day, failed or not, oldest first', () => {
    const due = botChatTabsDue(
      [
        chat('exactly-a-day', { lastActiveAt: NOW - BOT_CHAT_TAB_IDLE_MS }),
        chat('failed', { failedTotal: 2, finishedTotal: 2, lastActiveAt: OLD - 10 })
      ],
      NOW
    )
    expect(due.map((entry) => entry.chatId)).toEqual(['failed', 'exactly-a-day'])
  })

  it('keeps Home, threads, automation runs, group rooms, ended chats and chats with no tab', () => {
    const due = botChatTabsDue(
      [
        chat('home', { origin: 'home' }),
        chat('slack', { origin: 'slack' }),
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

  it('keeps a chat that replies, waits on the owner, has a worker going, or had a turn within the day', () => {
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
  it("closes a settled old request chat's tab, nothing else, and tells the bot's lists once", async () => {
    const host = fakeHost({
      chats: [chat('old'), chat('live', { live: 'replying' }), chat('home', { origin: 'home' })],
      tabs: [tab('old'), tab('live'), tab('home')]
    })
    expect(await tidyBotChatTabs(host)).toEqual({ closed: ['old'], refused: [], more: false })
    expect(host.closed).toEqual(['tab-old'])
    expect(host.notices).toEqual([['bot-1']])
  })

  it("keeps a person's own chat and any chat something still holds", async () => {
    const names = ['mine', 'dispatch', 'mail', 'item']
    const host = fakeHost({
      chats: names.map((name) => chat(name)),
      tabs: names.map((name) => tab(name)),
      admissions: {
        mine: { requestChat: false },
        dispatch: { holds: ['dispatch'] },
        mail: { holds: ['unread-mail'] },
        item: { holds: ['item'] }
      }
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual([])
    expect(host.closed).toEqual([])
    expect(host.notices).toEqual([])
  })

  it('counts mail as activity: a chat mailed within the day keeps its tab', async () => {
    const host = fakeHost({
      chats: [chat('mailed')],
      tabs: [tab('mailed')],
      admissions: { mailed: { lastMailAt: RECENT } }
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual([])
  })

  it('keeps a chat whose restart recovery is still offered, on any of its sessions', async () => {
    const host = fakeHost({
      chats: [chat('restart', { liveSessionId: 'restart-live' })],
      tabs: [tab('restart-live')],
      rootOf: { 'restart-live': 'restart' },
      restartHeld: ['restart-live']
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual([])
  })

  it('keeps a pinned, front, or recently focused tab, without reading its records', async () => {
    const host = fakeHost({
      chats: [chat('pinned'), chat('front'), chat('focused')],
      tabs: [tab('pinned', { isPinned: true }), tab('front', { isActive: true }), tab('focused')],
      focused: { 'tab-focused': RECENT }
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual([])
    expect(host.admissionCalls).toEqual([])
  })

  it('keeps a chat whose tab was brought forward after the first read', async () => {
    const host = fakeHost({
      chats: [chat('a')],
      tabs: [tab('a')],
      laterTabs: [tab('a', { isActive: true })]
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual([])
  })

  it('keeps a chat not at rest or on a screen when the close comes, by any of its sessions', async () => {
    const host = fakeHost({
      chats: [chat('root', { liveSessionId: 'cleared' }), chat('viewed')],
      tabs: [tab('cleared'), tab('viewed')],
      rootOf: { cleared: 'root' },
      unsettled: ['cleared', 'viewed']
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual([])
  })

  it("closes a /clear'd chat's tab, found through its lineage", async () => {
    const host = fakeHost({
      chats: [chat('root', { liveSessionId: 'cleared' })],
      tabs: [tab('cleared')],
      rootOf: { cleared: 'root' }
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual(['root'])
    expect(host.closed).toEqual(['tab-cleared'])
  })

  it('reports a refused close and passes over the chats the last pass was refused', async () => {
    const host = fakeHost({
      chats: [chat('refused'), chat('skipped')],
      tabs: [tab('refused'), tab('skipped')],
      outcomes: { 'tab-refused': 'refused' }
    })
    expect(await tidyBotChatTabs(host, new Set(['skipped']))).toEqual({
      closed: [],
      refused: ['refused'],
      more: false
    })
    expect(host.admissionCalls).toEqual(['refused'])
  })

  it('stops at its close budget, oldest first, and says more remain', async () => {
    const chats = [
      chat('newer', { lastActiveAt: OLD }),
      chat('oldest', { lastActiveAt: OLD - 20 }),
      chat('older', { lastActiveAt: OLD - 10 })
    ]
    const host = fakeHost({ chats, tabs: chats.map((entry) => tab(entry.chatId)) })
    expect(await tidyBotChatTabs(host, new Set(), { closes: 2, looks: 10 })).toEqual({
      closed: ['oldest', 'older'],
      refused: [],
      more: true
    })
  })

  it('stops at its look budget when every chat is kept', async () => {
    const chats = ['a', 'b', 'c'].map((name) => chat(name))
    const host = fakeHost({
      chats,
      tabs: chats.map((entry) => tab(entry.chatId)),
      admissions: { a: { requestChat: false }, b: { requestChat: false } }
    })
    expect(await tidyBotChatTabs(host, new Set(), { closes: 10, looks: 2 })).toMatchObject({
      closed: [],
      more: true
    })
    expect(host.admissionCalls).toEqual(['a', 'b'])
  })

  it('goes on past a chat whose close throws and a bot whose read fails', async () => {
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
      closeTab: async (workspaceId, entry) => {
        if (entry.tabId === 'tab-a') {
          throw new Error('write failed')
        }
        return host.closeTab(workspaceId, entry)
      }
    }
    expect(await tidyBotChatTabs(flaky)).toEqual({ closed: ['b'], refused: ['a'], more: false })
    expect(reads).toBe(2)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('BotChatTabTidyTicker', () => {
  it('runs first a while after launch, then hourly, never two at once', async () => {
    const run = vi.fn()
    const host = fakeHost({ chats: [], tabs: [] })
    const ticker = new BotChatTabTidyTicker(() => ({
      ...host,
      bots: () => {
        run()
        return []
      }
    }))
    const start = 1_000
    const first = start + BOT_CHAT_TAB_TIDY_SOON_MS
    await ticker.tick(start)
    await ticker.tick(first - 1)
    expect(run).not.toHaveBeenCalled()
    const running = ticker.tick(first)
    // A tick while the pass still runs starts nothing.
    await ticker.tick(first + BOT_CHAT_TAB_TIDY_EVERY_MS)
    await running
    expect(run).toHaveBeenCalledTimes(1)
    await ticker.tick(first + BOT_CHAT_TAB_TIDY_EVERY_MS - 1)
    expect(run).toHaveBeenCalledTimes(1)
    await ticker.tick(first + BOT_CHAT_TAB_TIDY_EVERY_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('comes back sooner while a backlog remains, and skips last pass refusals once', async () => {
    const chats = Array.from({ length: 50 }, (_, index) =>
      chat(`c${String(index).padStart(2, '0')}`, { lastActiveAt: OLD - 100 + index })
    )
    const host = fakeHost({
      chats,
      tabs: chats.map((entry) => tab(entry.chatId)),
      outcomes: { 'tab-c00': 'refused' }
    })
    const ticker = new BotChatTabTidyTicker(() => host)
    await ticker.tick(0)
    const first = await ticker.tick(BOT_CHAT_TAB_TIDY_SOON_MS)
    expect(first).toMatchObject({ refused: ['c00'], more: true })
    expect(first.closed).toHaveLength(39)
    const second = await ticker.tick(2 * BOT_CHAT_TAB_TIDY_SOON_MS)
    expect(second.closed).toHaveLength(10)
    expect(second.refused).toEqual([])
    expect(host.closed).toHaveLength(49)
  })
})
