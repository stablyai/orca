import { describe, expect, it, vi } from 'vitest'
import {
  BOT_CHAT_TAB_REPAIR_TRIES,
  BOT_CHAT_TAB_TIDY_EVERY_MS,
  BOT_CHAT_TAB_TIDY_SOON_MS,
  BotChatTabTidyTicker,
  tidyBotChatTabs,
  type BotChatTabCandidate,
  type BotChatTabState,
  type BotChatTabTidyHost
} from './bot-chat-tab-tidy'

type Plan = {
  /** Marked chat ids, in id order. */
  marks: string[]
  /** locate keeps these. */
  located?: Record<string, string>
  /** admit keeps these (first read). */
  kept?: string[]
  /** admit keeps these from the second read on (after the hide). */
  keptAfterHide?: string[]
  custody?: Map<string, string> | 'unreadable'
  consent?: Record<string, 'consent' | 'kept' | 'error'>
  /** The state read back after the hide. */
  after?: Record<string, BotChatTabState>
  hideThrows?: string[]
  listedAfter?: string[]
  revealThrows?: string[]
}

type Fake = BotChatTabTidyHost & {
  hidden: string[]
  revealed: string[]
  retired: string[]
  notices: string[][]
  checks: number
  plan: Plan
}

const candidate = (chatId: string): BotChatTabCandidate => ({
  chatId,
  botId: `bot-of-${chatId}`,
  workspaceId: 'home',
  lineage: [chatId],
  tabSessionId: chatId,
  tabId: `tab-${chatId}`
})

function fakeHost(plan: Plan): Fake {
  const admitted = new Map<string, number>()
  const fake: Fake = {
    plan,
    hidden: [],
    revealed: [],
    retired: [],
    notices: [],
    checks: 0,
    page: (after, limit) => plan.marks.filter((id) => id > after).slice(0, limit),
    locate: async (chatId) =>
      plan.located?.[chatId]
        ? { kind: 'keep', why: plan.located[chatId] }
        : { kind: 'candidate', ...candidate(chatId) },
    admit: async (c) => {
      const reads = (admitted.get(c.chatId) ?? 0) + 1
      admitted.set(c.chatId, reads)
      if (plan.kept?.includes(c.chatId) || (reads > 1 && plan.keptAfterHide?.includes(c.chatId))) {
        return { kind: 'keep', why: 'held' }
      }
      return {
        kind: 'go',
        check: () => {
          fake.checks += 1
        }
      }
    },
    custody: async () => {
      if (plan.custody === 'unreadable') {
        throw new Error('capsule unreadable')
      }
      return plan.custody ?? new Map()
    },
    consent: async (c) => plan.consent?.[c.chatId] ?? 'consent',
    hide: async (c, check) => {
      check()
      fake.hidden.push(c.chatId)
      if (plan.hideThrows?.includes(c.chatId)) {
        throw new Error('write answer lost')
      }
    },
    state: (c) =>
      plan.after?.[c.chatId] ?? (fake.hidden.includes(c.chatId) ? 'background' : 'visible'),
    listed: async (c) => plan.listedAfter?.includes(c.chatId) ?? false,
    retireListing: async (c) => {
      fake.retired.push(c.chatId)
    },
    reveal: async (c) => {
      if (plan.revealThrows?.includes(c.chatId)) {
        throw new Error('reveal failed')
      }
      fake.revealed.push(c.chatId)
    },
    changed: (botIds) => fake.notices.push([...botIds]),
    pause: async () => {},
    now: () => 0,
    warn: () => {}
  }
  return fake
}

const pass = (
  host: BotChatTabTidyHost,
  cursor = '',
  repairs: never[] | { candidate: BotChatTabCandidate; tries: number }[] = []
) => tidyBotChatTabs(host, { cursor, repairs })

describe('tidyBotChatTabs', () => {
  it('hides a marked chat once the window consents and the write admits it, then tells its bot', async () => {
    const host = fakeHost({ marks: ['a'] })
    const result = await pass(host)
    expect(result).toMatchObject({
      closed: ['a'],
      refused: [],
      revealed: [],
      more: false,
      cursor: ''
    })
    expect(host.checks).toBe(1)
    expect(host.notices).toEqual([['bot-of-a']])
  })

  it('keeps what locate or admission keeps, and asks no window', async () => {
    const host = fakeHost({ marks: ['a', 'b'], located: { a: 'tab-in-use' }, kept: ['b'] })
    const consent = vi.fn()
    expect((await pass({ ...host, consent })).closed).toEqual([])
    expect(consent).not.toHaveBeenCalled()
  })

  it('keeps every chat whose recovery custody is held or cannot be read', async () => {
    expect(
      (await pass(fakeHost({ marks: ['a', 'b'], custody: new Map([['a', 'pending']]) }))).closed
    ).toEqual(['b'])
    expect((await pass(fakeHost({ marks: ['a'], custody: 'unreadable' }))).closed).toEqual([])
  })

  it('changes nothing when the window keeps the tab or cannot answer', async () => {
    const host = fakeHost({ marks: ['a', 'b'], consent: { a: 'kept', b: 'error' } })
    const hide = vi.fn()
    expect(await pass({ ...host, hide })).toMatchObject({ closed: [], refused: ['a', 'b'] })
    expect(hide).not.toHaveBeenCalled()
  })

  it('reads the state back: a refused write changes nothing, a lost answer after commit is closed', async () => {
    const host = fakeHost({
      marks: ['refused', 'lost'],
      after: { refused: 'visible' },
      hideThrows: ['lost']
    })
    expect(await pass(host)).toMatchObject({ closed: ['lost'], refused: ['refused'] })
  })

  it('queues an unknown outcome for repair, by the identity it was tried with', async () => {
    const repairs: { candidate: BotChatTabCandidate; tries: number }[] = []
    const host = fakeHost({ marks: ['a'], after: { a: 'unknown' } })
    expect(await pass(host, '', repairs)).toMatchObject({ closed: [], refused: ['a'] })
    expect(repairs.map((entry) => entry.candidate.tabId)).toEqual(['tab-a'])
  })

  it('shows the chat again when something holds it once the hide committed', async () => {
    const host = fakeHost({ marks: ['a'], keptAfterHide: ['a'] })
    expect(await pass(host)).toMatchObject({ closed: [], revealed: ['a'] })
    expect(host.revealed).toEqual(['a'])
    expect(host.notices).toEqual([['bot-of-a']])
  })

  it('queues a repair when showing it again fails, or the committed tab is still listed', async () => {
    const repairs: { candidate: BotChatTabCandidate; tries: number }[] = []
    const host = fakeHost({
      marks: ['a', 'b'],
      keptAfterHide: ['a'],
      revealThrows: ['a'],
      listedAfter: ['b']
    })
    expect(await pass(host, '', repairs)).toMatchObject({ closed: ['b'] })
    expect(repairs.map((entry) => entry.candidate.chatId)).toEqual(['a', 'b'])
  })

  it('repairs first: a newer show wins, a committed leftover listing is retired, tries are capped', async () => {
    const repairs = [
      { candidate: candidate('shown'), tries: 0 },
      { candidate: candidate('leftover'), tries: 0 },
      { candidate: candidate('stuck'), tries: BOT_CHAT_TAB_REPAIR_TRIES - 1 }
    ]
    const host = fakeHost({
      marks: [],
      after: { shown: 'visible', leftover: 'background', stuck: 'unknown' },
      listedAfter: ['leftover']
    })
    await pass(host, '', repairs)
    expect(host.retired).toEqual(['leftover'])
    expect(repairs).toEqual([])
  })

  it('pages the marks after its cursor, charges a close per attempt, and resumes after where it stopped', async () => {
    const host = fakeHost({ marks: ['a', 'b', 'c'], consent: { a: 'kept' } })
    const first = await tidyBotChatTabs(host, {
      cursor: '',
      repairs: [],
      budget: { looks: 10, closes: 2, repairs: 1 }
    })
    expect(first).toMatchObject({ closed: ['b'], refused: ['a'], more: true, cursor: 'b' })
    const second = await tidyBotChatTabs(host, { cursor: first.cursor, repairs: [] })
    expect(second).toMatchObject({ closed: ['c'], more: false, cursor: '' })
  })

  it('reaches past kept marks and a removed cursor key, and wraps after a short page', async () => {
    const host = fakeHost({ marks: ['a', 'b', 'd'], kept: ['a', 'b'] })
    const first = await tidyBotChatTabs(host, {
      cursor: '',
      repairs: [],
      budget: { looks: 2, closes: 5, repairs: 1 }
    })
    expect(first).toMatchObject({ closed: [], more: true, cursor: 'b' })
    host.plan.marks = ['a', 'd']
    const second = await tidyBotChatTabs(host, { cursor: first.cursor, repairs: [] })
    expect(second).toMatchObject({ closed: ['d'], more: false, cursor: '' })
  })

  it('stops before its next chat once stopped', async () => {
    const host = fakeHost({ marks: ['a', 'b'] })
    let stop = false
    const result = await tidyBotChatTabs(
      { ...host, pause: async () => void (stop = true) },
      { cursor: '', repairs: [], stopped: () => stop }
    )
    expect(result).toMatchObject({ closed: ['a'], more: true, cursor: 'a' })
  })
})

describe('BotChatTabTidyTicker', () => {
  it('runs first a while after launch, then hourly, never two at once, and not after stop', async () => {
    const run = vi.fn((_after: string) => [])
    const host = fakeHost({ marks: [] })
    const ticker = new BotChatTabTidyTicker(() => ({ ...host, page: run }))
    const start = 1_000
    const first = start + BOT_CHAT_TAB_TIDY_SOON_MS
    await ticker.tick(start)
    await ticker.tick(first - 1)
    expect(run).not.toHaveBeenCalled()
    const running = ticker.tick(first)
    await ticker.tick(first + BOT_CHAT_TAB_TIDY_EVERY_MS)
    await running
    expect(run).toHaveBeenCalledTimes(1)
    await ticker.tick(first + BOT_CHAT_TAB_TIDY_EVERY_MS)
    expect(run).toHaveBeenCalledTimes(2)
    await ticker.stop()
    await ticker.tick(first + 3 * BOT_CHAT_TAB_TIDY_EVERY_MS)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('comes back sooner while marks remain, resuming from its cursor', async () => {
    const marks = Array.from({ length: 60 }, (_, index) => `c${String(index).padStart(2, '0')}`)
    const host = fakeHost({ marks })
    const ticker = new BotChatTabTidyTicker(() => host)
    await ticker.tick(0)
    const first = await ticker.tick(BOT_CHAT_TAB_TIDY_SOON_MS)
    expect(first.closed).toHaveLength(40)
    expect(first.more).toBe(true)
    const second = await ticker.tick(2 * BOT_CHAT_TAB_TIDY_SOON_MS)
    expect(second.closed).toHaveLength(20)
    expect(new Set(host.hidden).size).toBe(60)
  })
})
