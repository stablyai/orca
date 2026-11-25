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
  type BotChatTabConsent,
  type BotChatTabHide,
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
  bots?: string[]
  chats: BotChatTreeChat[] | Record<string, BotChatTreeChat[]>
  tabs: BotChatTabTidyTab[]
  keep?: string[]
  throwOn?: string[]
  consent?: Record<string, BotChatTabConsent>
  hide?: Record<string, BotChatTabHide>
  focused?: Record<string, number>
  rootOf?: Record<string, string>
  /** Tabs as the second (fresh) read sees them. */
  laterTabs?: BotChatTabTidyTab[]
}

type FakeHost = BotChatTabTidyHost & {
  hidden: string[]
  admitted: string[]
  notices: string[][]
  admitCalls: number
}

function fakeHost(input: FakeInput): FakeHost {
  const hidden: string[] = []
  const admitted: string[] = []
  const notices: string[][] = []
  let reads = 0
  const host: FakeHost = {
    hidden,
    admitted,
    notices,
    admitCalls: 0,
    bots: () => (input.bots ?? ['bot-1']).map((id) => ({ id, folderWorkspaceId: 'home-folder' })),
    chats: async (botId) => ({
      chats: Array.isArray(input.chats) ? input.chats : (input.chats[botId] ?? []),
      rootOf: (sessionId) => input.rootOf?.[sessionId] ?? sessionId
    }),
    tabs: async (workspaceId) => {
      reads += 1
      const base = reads > 1 && input.laterTabs ? input.laterTabs : input.tabs
      return workspaceId === WORKSPACE ? base.filter((entry) => !hidden.includes(entry.tabId)) : []
    },
    lastFocusedAt: (_workspaceId, entry) => input.focused?.[entry.tabId] ?? null,
    admission: async (_botId, entry) => {
      admitted.push(entry.chatId)
      if (input.throwOn?.includes(entry.chatId)) {
        throw new Error('unreadable')
      }
      return input.keep?.includes(entry.chatId)
        ? { kind: 'keep', why: 'held' }
        : {
            kind: 'go',
            admit: () => {
              host.admitCalls += 1
            }
          }
    },
    consent: async (workspaceId, entry) => {
      expect(workspaceId).toBe(WORKSPACE)
      return input.consent?.[entry.tabId] ?? 'consent'
    },
    hide: async (entry, admit) => {
      admit()
      const outcome = input.hide?.[entry.tabId] ?? 'committed'
      if (outcome === 'committed') {
        hidden.push(entry.tabId)
      }
      return outcome
    },
    changed: (botIds) => notices.push([...botIds]),
    pause: async () => {},
    now: () => NOW,
    warn: () => {}
  }
  return host
}

describe('botChatTabsDue', () => {
  it('takes settled side chats with no turn for a day, failed or not', () => {
    const due = botChatTabsDue(
      [
        chat('exactly-a-day', { lastActiveAt: NOW - BOT_CHAT_TAB_IDLE_MS }),
        chat('failed', { failedTotal: 2, finishedTotal: 2 })
      ],
      NOW
    )
    expect(due.map((entry) => entry.chatId)).toEqual(['exactly-a-day', 'failed'])
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
  it('hides a settled chat after the window consents, admits again inside the write, and tells its bot once', async () => {
    const host = fakeHost({
      chats: [chat('old'), chat('live', { live: 'replying' }), chat('home', { origin: 'home' })],
      tabs: [tab('old'), tab('live'), tab('home')]
    })
    expect(await tidyBotChatTabs(host)).toMatchObject({ closed: ['old'], refused: [], more: false })
    expect(host.hidden).toEqual(['tab-old'])
    expect(host.admitCalls).toBe(1)
    expect(host.notices).toEqual([['bot-1']])
  })

  it('keeps a chat its records hold, without asking the window', async () => {
    const consent = vi.fn()
    const host = fakeHost({ chats: [chat('held')], tabs: [tab('held')], keep: ['held'] })
    const pass = await tidyBotChatTabs({ ...host, consent })
    expect(pass.closed).toEqual([])
    expect(consent).not.toHaveBeenCalled()
    expect(host.notices).toEqual([])
  })

  it('keeps a pinned, front or recently focused tab, and a chat with two tabs, without reading records', async () => {
    const host = fakeHost({
      chats: [chat('pinned'), chat('front'), chat('focused'), chat('two')],
      tabs: [
        tab('pinned', { isPinned: true }),
        tab('front', { isActive: true }),
        tab('focused'),
        tab('two'),
        tab('two-b', { tabId: 'tab-two-again' })
      ],
      rootOf: { 'two-b': 'two' },
      focused: { 'tab-focused': RECENT }
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual([])
    expect(host.admitted).toEqual([])
  })

  it('keeps a tab brought forward or replaced after its records were read', async () => {
    const forward = fakeHost({
      chats: [chat('a')],
      tabs: [tab('a')],
      laterTabs: [tab('a', { isActive: true })]
    })
    expect((await tidyBotChatTabs(forward)).closed).toEqual([])
    const replaced = fakeHost({
      chats: [chat('a')],
      tabs: [tab('a')],
      laterTabs: [tab('a', { tabId: 'tab-reopened' })]
    })
    expect((await tidyBotChatTabs(replaced)).closed).toEqual([])
  })

  it('changes nothing when the window keeps the tab or cannot answer', async () => {
    const hide = vi.fn()
    const host = fakeHost({
      chats: [chat('kept'), chat('silent')],
      tabs: [tab('kept'), tab('silent')],
      consent: { 'tab-kept': 'kept', 'tab-silent': 'error' }
    })
    const pass = await tidyBotChatTabs({ ...host, hide })
    expect(pass).toMatchObject({ closed: [], refused: ['kept', 'silent'] })
    expect(hide).not.toHaveBeenCalled()
    expect(host.notices).toEqual([])
  })

  it('reports a hide the write refused or failed, and tells no one', async () => {
    const host = fakeHost({
      chats: [chat('refused'), chat('failed')],
      tabs: [tab('refused'), tab('failed')],
      hide: { 'tab-refused': 'refused', 'tab-failed': 'error' }
    })
    expect(await tidyBotChatTabs(host)).toMatchObject({
      closed: [],
      // Same activity, so ordered by chat id.
      refused: ['failed', 'refused']
    })
    expect(host.notices).toEqual([])
  })

  it("hides a /clear'd chat's tab, found through its lineage", async () => {
    const host = fakeHost({
      chats: [chat('root', { liveSessionId: 'cleared' })],
      tabs: [tab('cleared')],
      rootOf: { cleared: 'root' }
    })
    expect((await tidyBotChatTabs(host)).closed).toEqual(['root'])
    expect(host.hidden).toEqual(['tab-cleared'])
  })

  it('charges a close per attempt, oldest first per bot, and resumes after where it stopped', async () => {
    const chats = [
      chat('newer', { lastActiveAt: OLD }),
      chat('oldest', { lastActiveAt: OLD - 20 }),
      chat('older', { lastActiveAt: OLD - 10 })
    ]
    const host = fakeHost({
      chats,
      tabs: chats.map((entry) => tab(entry.chatId)),
      consent: { 'tab-oldest': 'kept' }
    })
    const first = await tidyBotChatTabs(host, null, { closes: 2, looks: 10 })
    expect(first).toMatchObject({ closed: ['older'], refused: ['oldest'], more: true })
    const second = await tidyBotChatTabs(host, first.cursor, { closes: 2, looks: 10 })
    expect(second.closed).toEqual(['newer'])
  })

  it('reaches past a prefix of held and unreadable chats and later bots on following passes', async () => {
    const held = Array.from({ length: 3 }, (_, index) =>
      chat(`a-held-${index}`, { lastActiveAt: OLD - 100 + index })
    )
    const host = fakeHost({
      bots: ['bot-a', 'bot-b'],
      chats: {
        'bot-a': [...held, chat('a-broken', { lastActiveAt: OLD })],
        'bot-b': [chat('b-tail')]
      },
      tabs: [...held.map((entry) => tab(entry.chatId)), tab('a-broken'), tab('b-tail')],
      keep: held.map((entry) => entry.chatId),
      throwOn: ['a-broken']
    })
    let cursor = null
    const closed: string[] = []
    for (let pass = 0; pass < 3 && !closed.includes('b-tail'); pass += 1) {
      const result = await tidyBotChatTabs(host, cursor, { closes: 10, looks: 2 })
      closed.push(...result.closed)
      cursor = result.cursor
    }
    expect(closed).toEqual(['b-tail'])
  })

  it('goes on past a bot whose chats cannot be read', async () => {
    const host = fakeHost({
      bots: ['broken', 'bot-1'],
      chats: { 'bot-1': [chat('b')] },
      tabs: [tab('b')]
    })
    const warn = vi.fn()
    const pass = await tidyBotChatTabs({
      ...host,
      warn,
      chats: async (botId) => {
        if (botId === 'broken') {
          throw new Error('unreadable')
        }
        return host.chats(botId)
      }
    })
    expect(pass.closed).toEqual(['b'])
    expect(warn).toHaveBeenCalledTimes(1)
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

  it('comes back sooner while a budget ran out, and finishes the backlog', async () => {
    const chats = Array.from({ length: 50 }, (_, index) =>
      chat(`c${String(index).padStart(2, '0')}`, { lastActiveAt: OLD - 100 + index })
    )
    const host = fakeHost({ chats, tabs: chats.map((entry) => tab(entry.chatId)) })
    const ticker = new BotChatTabTidyTicker(() => host)
    await ticker.tick(0)
    const first = await ticker.tick(BOT_CHAT_TAB_TIDY_SOON_MS)
    expect(first).toMatchObject({ more: true })
    expect(first.closed).toHaveLength(40)
    const second = await ticker.tick(2 * BOT_CHAT_TAB_TIDY_SOON_MS)
    expect(second.closed).toHaveLength(10)
    expect(host.hidden).toHaveLength(50)
  })
})
