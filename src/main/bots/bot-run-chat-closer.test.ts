import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../shared/agent-session/identity/orca-session-address'
import type { AutomationRunStatus } from '../../shared/automations/history/automation-run'
import {
  RUN_CHAT_KEEP_REASONS,
  RUN_CHAT_QUIET_MS,
  runChatKeeps,
  runChatRunEnded,
  type RunChatFacts,
  type RunChatKeepReason
} from '../../shared/bots/bot-run-chat-close'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type * as ChatSessions from './bot-chat-session'
import type * as CloseStep from './bot-run-chat-close-step'

type ChatSessionModule = typeof ChatSessions
type CloseStepModule = typeof CloseStep

const chats = vi.hoisted(() => {
  const rows: BotChatRow[] = []
  return { rows }
})
vi.mock('../runtime/rpc/methods/bots-chats', () => ({
  readBotChats: async (_runtime: unknown, _bot: unknown, _caller: unknown, all = false) =>
    all ? chats.rows : chats.rows.filter((row) => !row.closed)
}))

const world = vi.hoisted(() => {
  const closeCalls: string[] = []
  const settled: { botId: string; closed: string[]; open: string[] }[] = []
  const noBot = (): Bot | null => null
  return {
    journals: new Map<string, { first: unknown; 'last-person': unknown }>(),
    working: new Set<string>(),
    tabs: new Set<string>(),
    closeCalls,
    /** Runs before the recheck under the lock, as mail arriving meanwhile would. */
    beforeRecheck: () => {},
    /** The bot a session's chat is in, as the per-run timer finds it. */
    sessionBot: noBot(),
    /** Each chat's sessions from its root, for a chat a /clear moved on. */
    lineage: new Map<string, string[]>(),
    /** Chats whose journal cannot be read. */
    unreadable: new Set<string>(),
    /** Chats a tab opened on after the recheck, which the close's last word refuses. */
    tabAtClose: new Set<string>(),
    /** Bots with a close left to finish, and each finishing look: the bot and the chats it saw. */
    owing: new Set<string>(),
    settled
  }
})
vi.mock('../external-conversations/external-conversation-chat', () => ({
  chatIsIdle: (_host: unknown, id: string) => !world.working.has(id),
  chatPaneKey: (id: string) => `pane:${id}`
}))
vi.mock('../runtime/orchestration/addressing/session-lineage/structured-session-lineage', () => ({
  readAgentSessionRecordStore: () => ({}),
  resolveLineageRunningSession: (_store: unknown, id: string) => {
    const lineage = world.lineage.get(id) ?? [id]
    return { kind: 'here', sessionId: lineage.at(-1), lineage }
  }
}))
vi.mock('./bot-session-tabs', () => ({ botOfSession: () => world.sessionBot }))
vi.mock('./bot-chat-session', () => ({
  requireStructuredHost: async () => ({
    journalReads: async (id: string) => {
      if (world.unreadable.has(id)) {
        throw new Error('journal unreadable')
      }
      return {
        promptItem: async (end: 'first' | 'last-person') => world.journals.get(id)?.[end] ?? null
      }
    },
    getSessionTabId: (id: string) => (world.tabs.has(id) ? 'tab' : null)
  })
}))
vi.mock('./bot-run-chat-close-step', () => ({
  runtimeRunChatClose: () => ({
    close: async (_botId: string, sessionId: string, ended: () => Promise<boolean>) => {
      world.beforeRecheck()
      if (!(await ended())) {
        return 'kept'
      }
      if (world.tabAtClose.has(sessionId)) {
        return 'tab-open'
      }
      world.closeCalls.push(sessionId)
      // A row is listed by its root, and closed by the session running it.
      chats.rows = chats.rows.filter(
        (row) => (world.lineage.get(row.id)?.at(-1) ?? row.id) !== sessionId
      )
      return 'closed'
    },
    settle: async (botId: string, now: { closed: Set<string>; open: Set<string> }) => {
      world.settled.push({ botId, closed: [...now.closed], open: [...now.open] })
    }
  }),
  runChatClosesOwed: (_runtime: unknown, botId: string) => world.owing.has(botId)
}))

const { closeEndedRunChats, previewRunChats } = await import('./bot-run-chat-closer')
const { bindRunChatChecks, scheduleRunChatCheck } = await import('./bot-run-chat-checks')
// The real lock and close order; the closer above reads mocked ones.
const { botChatSessions } = await vi.importActual<ChatSessionModule>('./bot-chat-session')
const { closeRunChatUnderLock, settleClosedRunChats } = await vi.importActual<CloseStepModule>(
  './bot-run-chat-close-step'
)

// A fixed clock, so the quiet window never depends on when the test runs.
const NOW = Date.UTC(2026, 10, 25, 9, 0)
const OLD = NOW - RUN_CHAT_QUIET_MS - 60_000

function runMessage(runId: string) {
  return {
    itemId: `first-${runId}`,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [],
      origin: 'automation-run',
      automationRun: {
        runId,
        automation: { id: 'auto-1', name: 'Nightly' },
        trigger: 'scheduled',
        instructionsLength: 0
      }
    }
  }
}

function row(id: string, overrides: Partial<BotChatRow> = {}): BotChatRow {
  return {
    id,
    title: 'a chat',
    lastActivityAt: OLD,
    lastAsked: null,
    lastSaid: null,
    home: false,
    self: false,
    closed: false,
    ...overrides
  }
}

type Fixture = {
  runs: { id: string; status: string }[]
  automations: unknown[]
  unread: Set<string>
  liveRuns: Set<string>
  threads: Set<string>
  items: { chatId: string; number: number; status: string }[]
}

function setup(bot: Partial<Bot> = {}) {
  const fixture: Fixture = {
    runs: [],
    automations: [],
    unread: new Set(),
    liveRuns: new Set(),
    threads: new Set(),
    items: []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the closer reads only these fields of the bot.
  const theBot = {
    id: 'bot-1',
    name: 'Nightly bot',
    chatSessionId: 'home-chat',
    folderWorkspaceId: 'home',
    closeEndedRuns: true,
    ...bot
  } as Bot
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the closer reads only these.
  const runtime = {
    bots: { list: () => [theBot] },
    ensureStructuredAgentSessionHost: async () => {},
    requireStore: () => ({ listAutomations: () => fixture.automations }),
    listAutomationRuns: () => fixture.runs,
    getOrchestrationDb: () => ({
      getUnreadMessages: (address: string) => (fixture.unread.has(address) ? [{}] : []),
      runsBoundToCoordinator: ({ orcaSessionId }: { orcaSessionId: string }) =>
        fixture.liveRuns.has(orcaSessionId) ? [{ id: `run-of-${orcaSessionId}` }] : [],
      db: { prepare: () => ({ get: () => ({ live: 1 }) }) }
    }),
    getExternalConversationSeam: () => ({
      replyTarget: (pane: string) =>
        fixture.threads.has(pane) ? { key: { source: 'slack' } } : null
    }),
    botItems: {
      store: () => ({
        // A page of `limit` rows, and exact counts per status, as the store gives them.
        list: async ({ chatIds, limit }: { chatIds: string[]; limit: number }) => {
          const owned = fixture.items.filter((item) => chatIds.includes(item.chatId))
          const counts: Record<string, number> = {}
          owned.forEach((item) => (counts[item.status] = (counts[item.status] ?? 0) + 1))
          return { items: owned.slice(0, limit), counts }
        }
      })
    }
  } as unknown as OrcaRuntimeService
  return { fixture, bot: theBot, runtime }
}

function mailAddress(id: string): string {
  if (!isOrcaSessionId(id)) {
    throw new Error(`${id} is no session id`)
  }
  return formatOrcaSessionAddress(id)
}

/** A run chat whose run ended long ago, with nothing else on it. */
function runChat(): string {
  const id = randomUUID()
  world.journals.set(id, {
    first: runMessage(`run-${id}`),
    'last-person': null
  })
  chats.rows.push(row(id))
  return id
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  chats.rows = [row('home-chat', { home: true })]
  world.journals.clear()
  world.working.clear()
  world.tabs.clear()
  world.closeCalls = []
  world.beforeRecheck = () => {}
  world.sessionBot = null
  world.lineage.clear()
  world.unreadable.clear()
  world.tabAtClose.clear()
  world.owing.clear()
  world.settled = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('run chat verdict', () => {
  it('keeps a chat for each fact that holds, and closes it when none does', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the entries name every reason once.
    const none = Object.fromEntries(RUN_CHAT_KEEP_REASONS.map((r) => [r, false])) as RunChatFacts
    expect(runChatKeeps(none)).toEqual([])
    for (const reason of RUN_CHAT_KEEP_REASONS) {
      expect(runChatKeeps({ ...none, [reason]: true })).toEqual([reason])
    }
  })

  it('counts a run still pending, dispatching or dispatched as going, and one missing from history as ended', () => {
    const open: AutomationRunStatus[] = ['pending', 'dispatching', 'dispatched']
    expect(open.map((s) => runChatRunEnded(s))).toEqual([false, false, false])
    expect(runChatRunEnded('completed')).toBe(true)
    expect(runChatRunEnded(undefined)).toBe(true)
  })
})

describe('closing ended run chats', () => {
  it('judges only the chats a run opened, and closes one whose run left history', async () => {
    const { bot, runtime } = setup()
    const ended = runChat()
    const person = randomUUID()
    world.journals.set(person, {
      first: { itemId: 'p', body: { kind: 'message' } },
      'last-person': null
    })
    chats.rows.push(row(person))

    const preview = await previewRunChats(runtime, bot)
    expect(preview).toMatchObject({
      open: 3,
      notRunChats: 2,
      unreadable: 0,
      itemsCut: false,
      keep: []
    })
    expect(preview.close.map((chat) => chat.chatId)).toEqual([ended])

    await expect(closeEndedRunChats(runtime, bot)).resolves.toMatchObject({
      closed: 1,
      failed: 0
    })
    expect(world.closeCalls).toEqual([ended])
  })

  it('keeps a run chat for each thing that still waits on it', async () => {
    const { fixture, bot, runtime } = setup()
    const make: Record<RunChatKeepReason, (id: string) => void> = {
      'run-not-ended': (id) => fixture.runs.push({ id: `run-${id}`, status: 'dispatched' }),
      recent: (id) => (chats.rows.find((r) => r.id === id)!.lastActivityAt = NOW),
      working: (id) => world.working.add(id),
      'unread-mail': (id) => fixture.unread.add(mailAddress(id)),
      'open-item': (id) => fixture.items.push({ chatId: id, number: 6, status: 'waiting' }),
      'automation-target': (id) =>
        fixture.automations.push({
          bot: { botId: 'bot-1', chat: { sessionId: id } }
        }),
      thread: (id) => fixture.threads.add(`pane:${id}`),
      'live-run': (id) => fixture.liveRuns.add(id),
      'tab-open': (id) => world.tabs.add(id),
      'person-spoke': (id) =>
        (world.journals.get(id)!['last-person'] = {
          itemId: 'typed',
          body: { kind: 'message' }
        })
    }
    const kept = new Map<string, RunChatKeepReason>()
    for (const reason of RUN_CHAT_KEEP_REASONS) {
      const id = runChat()
      make[reason](id)
      kept.set(id, reason)
    }
    const doneItem = runChat()
    fixture.items.push({ chatId: doneItem, number: 11, status: 'done' })

    const preview = await previewRunChats(runtime, bot)
    expect(preview.keep.map((chat) => [chat.chatId, chat.keep])).toEqual(
      [...kept].map(([id, reason]) => [id, [reason]])
    )
    expect(preview.close).toEqual([
      expect.objectContaining({
        chatId: doneItem,
        items: [{ number: 11, status: 'done' }]
      })
    ])
    expect(preview.itemMailTo).toEqual({
      chatId: 'home-chat',
      title: 'a chat'
    })
  })

  it('keeps a chat owning an open item past the page of items the preview lists', async () => {
    const { fixture, bot, runtime } = setup()
    const id = runChat()
    for (let number = 1; number <= 1000; number++) {
      fixture.items.push({ chatId: id, number, status: 'done' })
    }
    fixture.items.push({ chatId: id, number: 1001, status: 'waiting' })
    const preview = await previewRunChats(runtime, bot)
    expect(preview.close).toEqual([])
    expect(preview.keep.map((chat) => chat.keep)).toEqual([['open-item']])
    // The row lists one page of them, and says so.
    expect(preview.keep[0].items).toHaveLength(1000)
    expect(preview.itemsCut).toBe(true)
  })

  it('counts a chat it cannot read apart from the chats no run opened, and leaves it open', async () => {
    const { bot, runtime } = setup()
    world.unreadable.add(runChat())
    await expect(previewRunChats(runtime, bot)).resolves.toMatchObject({
      open: 2,
      notRunChats: 1,
      unreadable: 1,
      close: [],
      keep: []
    })
    await expect(closeEndedRunChats(runtime, bot)).resolves.toMatchObject({
      closed: 0,
      failed: 0
    })
    expect(world.closeCalls).toEqual([])
  })

  it('counts a chat whose tab opened just before its close as kept for its tab, not as failed', async () => {
    const { bot, runtime } = setup()
    world.tabAtClose.add(runChat())
    await expect(closeEndedRunChats(runtime, bot)).resolves.toEqual({
      closed: 0,
      failed: 0,
      kept: { 'tab-open': 1 }
    })
  })

  it('looks again once it ends when a look came while it ran, so a chat it kept is judged again', async () => {
    const { bot, runtime } = setup()
    const shown = runChat()
    world.tabs.add(shown)
    const closable = runChat()
    let during: Promise<unknown> = Promise.resolve()
    world.beforeRecheck = () => {
      world.beforeRecheck = () => {}
      // The tab closes and its look comes while this one still runs.
      world.tabs.delete(shown)
      during = closeEndedRunChats(runtime, bot)
    }
    await closeEndedRunChats(runtime, bot)
    await expect(during).resolves.toBeNull()
    await vi.waitFor(() => expect(world.closeCalls).toEqual([closable, shown]))
  })

  it('finishes a close left unfinished while the setting is off, and closes nothing new', async () => {
    const { bot, runtime } = setup({ closeEndedRuns: false })
    const open = runChat()
    const closed = runChat()
    chats.rows.find((chat) => chat.id === closed)!.closed = true
    // Owing nothing, it reads no chats.
    await expect(closeEndedRunChats(runtime, bot)).resolves.toBeNull()
    expect(world.settled).toEqual([])

    world.owing.add(bot.id)
    await expect(closeEndedRunChats(runtime, bot)).resolves.toBeNull()
    expect(world.settled).toEqual([{ botId: 'bot-1', closed: [closed], open: [open] }])
    expect(world.closeCalls).toEqual([])
  })

  it('does nothing while the setting is off', async () => {
    const { bot, runtime } = setup({ closeEndedRuns: undefined })
    runChat()
    await expect(closeEndedRunChats(runtime, bot)).resolves.toBeNull()
    expect(world.closeCalls).toEqual([])
  })

  it('reads a person in any session of a chat a /clear moved on, and closes the session running it', async () => {
    const { bot, runtime } = setup()
    const id = runChat()
    const cleared = randomUUID()
    const live = randomUUID()
    world.lineage.set(id, [id, cleared, live])
    world.journals.set(live, { first: null, 'last-person': null })
    world.journals.set(cleared, {
      first: null,
      'last-person': { itemId: 'typed', body: { kind: 'message' } }
    })
    const preview = await previewRunChats(runtime, bot)
    expect(preview.keep.map((chat) => [chat.chatId, chat.keep])).toEqual([[id, ['person-spoke']]])

    world.journals.set(cleared, { first: null, 'last-person': null })
    await expect(closeEndedRunChats(runtime, bot)).resolves.toMatchObject({
      failed: 0
    })
    expect(world.closeCalls).toEqual([live])
  })

  it('leaves a chat a /clear moved on between the read and the lock for the next look', async () => {
    const { bot, runtime } = setup()
    const id = runChat()
    const next = randomUUID()
    world.journals.set(next, { first: null, 'last-person': null })
    world.beforeRecheck = () => world.lineage.set(id, [id, next])
    await expect(closeEndedRunChats(runtime, bot)).resolves.toMatchObject({
      closed: 0
    })
    expect(world.closeCalls).toEqual([])
  })

  it('keeps a chat that mail reached between the read and the lock', async () => {
    const { fixture, bot, runtime } = setup()
    const id = runChat()
    world.beforeRecheck = () => fixture.unread.add(mailAddress(id))
    await expect(closeEndedRunChats(runtime, bot)).resolves.toMatchObject({
      closed: 0,
      kept: { 'unread-mail': 1 }
    })
    expect(world.closeCalls).toEqual([])
  })
})

describe('when a bot looks at its run chats', () => {
  it('looks once its setting turns on, not on its other saves, and once a quiet window after start', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    const { bot, runtime } = setup({ closeEndedRuns: false })
    let botsWritten = () => {}
    Object.assign(runtime, {
      onBotsWritten: (listener: () => void) => {
        botsWritten = listener
        return () => {}
      }
    })
    const piledUp = runChat()
    const stop = bindRunChatChecks(runtime)

    botsWritten()
    await vi.advanceTimersByTimeAsync(0)
    expect(world.closeCalls).toEqual([])

    bot.closeEndedRuns = true
    botsWritten()
    await vi.waitFor(() => expect(world.closeCalls).toEqual([piledUp]))

    const later = runChat()
    botsWritten()
    await vi.advanceTimersByTimeAsync(0)
    expect(world.closeCalls).toEqual([piledUp])

    await vi.advanceTimersByTimeAsync(RUN_CHAT_QUIET_MS)
    await vi.waitFor(() => expect(world.closeCalls).toEqual([piledUp, later]))
    stop()
  })

  it("looks once its run's chat has been quiet for the window, and not while the setting is off", async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    const { bot, runtime } = setup()
    world.sessionBot = bot
    const id = runChat()
    scheduleRunChatCheck(runtime, id)
    await vi.advanceTimersByTimeAsync(RUN_CHAT_QUIET_MS)
    expect(world.closeCalls).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(world.closeCalls).toEqual([id]))

    bot.closeEndedRuns = false
    const off = runChat()
    scheduleRunChatCheck(runtime, off)
    await vi.advanceTimersByTimeAsync(RUN_CHAT_QUIET_MS + 30_000)
    expect(world.closeCalls).toEqual([id])
    expect(world.settled).toEqual([])

    // Off but with a close left to finish, it looks, and only finishes that.
    world.owing.add(bot.id)
    scheduleRunChatCheck(runtime, off)
    await vi.advanceTimersByTimeAsync(RUN_CHAT_QUIET_MS + 30_000)
    await vi.waitFor(() => expect(world.settled.map((look) => look.botId)).toEqual(['bot-1']))
    expect(world.closeCalls).toEqual([id])
  })

  it('looks once after start at a bot with a close left to finish, its setting off', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    const { runtime } = setup({ closeEndedRuns: false })
    Object.assign(runtime, { onBotsWritten: () => () => {} })
    runChat()
    const stop = bindRunChatChecks(runtime)
    world.owing.add('bot-1')
    await vi.advanceTimersByTimeAsync(RUN_CHAT_QUIET_MS)
    await vi.waitFor(() => expect(world.settled.map((look) => look.botId)).toEqual(['bot-1']))
    expect(world.closeCalls).toEqual([])
    stop()
  })
})

describe('closing one run chat under the bot lock', () => {
  /** `owed` stands for the database, so a second `sessions` over it is the same Orca restarted. */
  function sessions(
    closed: Awaited<ReturnType<CloseStep.RunChatCloseSteps['close']>>,
    owed = new Map<string, string>()
  ) {
    const calls: string[] = []
    const fail = { home: false, carry: false, handOver: false, drop: false, forget: false }
    /** Chats whose unread mail cannot even be looked at, which throws out of the whole finish. */
    const throwsFor = new Set<string>()
    const host = {
      deps: {
        store: {
          getConversation: (id: string) =>
            id === 'home-chat' && !fail.home ? { provider: 'codex', sessionId: 'home-chat' } : null
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat lock reads only these fields of the bot.
    const bot = {
      id: 'bot-1',
      agent: 'codex',
      chatSessionId: 'home-chat',
      closeEndedRuns: true
    } as Bot
    const chats = botChatSessions({
      bots: { list: () => [bot], setChatSession: async () => bot },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opening Home Chat reads only the store's conversation.
      host: async () => host as never,
      createChat: async () => {
        throw new Error('no Home Chat')
      },
      showTab: async () => {},
      closeChat: async () => ({ stopped: true }),
      dropUnreadMail: async () => {}
    })
    const steps: CloseStep.RunChatCloseSteps = {
      close: async (id) => {
        calls.push(`close ${id}`)
        return closed
      },
      // As the real move does, a card that stayed is told by its result, not thrown.
      carry: async (_host, from, to) => {
        if (fail.carry) {
          return false
        }
        calls.push(`carry ${from} -> ${to}`)
        return true
      },
      handOver: (from, to) => {
        if (fail.handOver) {
          throw new Error('hand over failed')
        }
        calls.push(`hand over ${from} -> ${to}`)
      },
      dropUnreadMail: (_bot, from) => {
        if (throwsFor.has(from)) {
          throw new Error('mail unreadable')
        }
        if (fail.drop) {
          return Promise.reject(new Error('drop failed'))
        }
        calls.push(`drop ${from}`)
        return Promise.resolve()
      },
      owed: {
        add: (botId, sessionId) => owed.set(sessionId, botId),
        forget: (sessionId) => {
          if (fail.forget) {
            throw new Error('database busy')
          }
          owed.delete(sessionId)
        },
        list: (botId) => [...owed].flatMap(([id, owner]) => (owner === botId ? [id] : []))
      }
    }
    const close = (sessionId: string, ended: boolean) =>
      closeRunChatUnderLock(chats, steps, 'bot-1', sessionId, async () => ended)
    /** The next look at the bot's chats: the sessions of those closed and of those open. */
    const settle = (closedChats: string[], openChats: string[] = []) =>
      settleClosedRunChats(chats, steps, 'bot-1', {
        closed: new Set(closedChats),
        open: new Set(openChats)
      })
    return { calls, close, settle, fail, throwsFor, bot, owed }
  }

  const moves = (id: string) => [
    `carry ${id} -> home-chat`,
    `hand over ${id} -> home-chat`,
    `drop ${id}`
  ]

  it('closes, then moves what was queued and coordinated there to the Home Chat', async () => {
    const { calls, close, owed } = sessions({ stopped: true })
    await expect(close('run-chat', true)).resolves.toBe('closed')
    expect(calls).toEqual(['close run-chat', ...moves('run-chat')])
    expect(owed.size).toBe(0)
  })

  it('leaves the chat and its mail alone when the recheck keeps it, the setting went off, or the close is refused', async () => {
    const kept = sessions({ stopped: true })
    await expect(kept.close('run-chat', false)).resolves.toBe('kept')
    await expect(kept.close('home-chat', true)).resolves.toBe('kept')
    kept.bot.closeEndedRuns = false
    await expect(kept.close('run-chat', true)).resolves.toBe('kept')
    expect(kept.calls).toEqual([])

    const refused = sessions({ stopped: false })
    await expect(refused.close('run-chat', true)).resolves.toBe('failed')
    expect(refused.calls).toEqual(['close run-chat'])
    expect(refused.owed.size).toBe(0)

    // A tab that opened since the recheck refused it at the close's last word.
    const shown = sessions({ stopped: false, tabOpen: true })
    await expect(shown.close('run-chat', true)).resolves.toBe('tab-open')
    expect(shown.calls).toEqual(['close run-chat'])
    expect(shown.owed.size).toBe(0)
  })

  it('leaves the run chat open when the Home Chat cannot open', async () => {
    const { calls, close, fail } = sessions({ stopped: true })
    fail.home = true
    await expect(close('run-chat', true)).rejects.toThrow('no Home Chat')
    expect(calls).toEqual([])
  })

  it('finishes on a later look every move a failed one left, after a restart too', async () => {
    const owed = new Map<string, string>()
    const before = sessions({ stopped: true }, owed)
    const carried = randomUUID()
    before.fail.carry = true
    await expect(before.close(carried, true)).resolves.toBe('closed')
    // The Runs and the senders still went on; the cards wait for the next look.
    expect(before.calls).toEqual([`close ${carried}`, ...moves(carried).slice(1)])
    // Restarted: nothing of the first Orca is left but what the database kept.
    const { calls, settle } = sessions({ stopped: true }, owed)
    await settle([carried, randomUUID()])
    expect(calls).toEqual(moves(carried))
    calls.length = 0
    await settle([carried])
    expect(calls).toEqual([])
  })

  it('keeps the record until the Runs and the senders went on too, and a failed forget holds up nothing', async () => {
    const handOver = sessions({ stopped: true })
    handOver.fail.handOver = true
    await expect(handOver.close('run-chat', true)).resolves.toBe('closed')
    expect(handOver.calls).toEqual([
      'close run-chat',
      'carry run-chat -> home-chat',
      'drop run-chat'
    ])
    handOver.fail.handOver = false
    handOver.calls.length = 0
    await handOver.settle(['run-chat'])
    expect(handOver.calls).toEqual(moves('run-chat'))
    expect(handOver.owed.size).toBe(0)

    const drop = sessions({ stopped: true })
    drop.fail.drop = true
    await expect(drop.close('run-chat', true)).resolves.toBe('closed')
    expect(drop.owed.size).toBe(1)
    drop.fail.drop = false
    drop.calls.length = 0
    await drop.settle(['run-chat'])
    expect(drop.calls).toEqual(moves('run-chat'))
    expect(drop.owed.size).toBe(0)

    const forget = sessions({ stopped: true })
    forget.fail.forget = true
    await expect(forget.close('run-chat', true)).resolves.toBe('closed')
    expect(forget.calls).toEqual(['close run-chat', ...moves('run-chat')])
    expect(forget.owed.size).toBe(1)
  })

  it('closes a chat whose agent was still starting once that start ends, and moves what it left then', async () => {
    let startEnds: (stopped: boolean) => void = () => {}
    const whenStopped = new Promise<boolean>((resolve) => (startEnds = resolve))
    const starting = sessions({ stopped: false, whenStopped })
    await expect(starting.close('run-chat', true)).resolves.toBe('stopping')
    expect(starting.calls).toEqual(['close run-chat'])
    expect(starting.owed.size).toBe(1)
    startEnds(true)
    await vi.waitFor(() => expect(starting.owed.size).toBe(0))
    expect(starting.calls).toEqual(['close run-chat', ...moves('run-chat')])

    // A start that ended with no proof the chat closed leaves the record for the next look to judge.
    const unproven = Promise.resolve(false)
    const unprovenClose = sessions({ stopped: false, whenStopped: unproven })
    await expect(unprovenClose.close('run-chat', true)).resolves.toBe('stopping')
    await unproven
    expect(unprovenClose.calls).toEqual(['close run-chat'])
    expect(unprovenClose.owed.size).toBe(1)
  })

  it('holds up nothing on a record it cannot drop: a tab still refuses as tab-open, and the next records settle', async () => {
    const shown = sessions({ stopped: false, tabOpen: true })
    shown.fail.forget = true
    await expect(shown.close('run-chat', true)).resolves.toBe('tab-open')
    expect(shown.owed.size).toBe(1)

    const owed = new Map([
      ['reopened', 'bot-1'],
      ['run-chat', 'bot-1']
    ])
    const { calls, settle, fail } = sessions({ stopped: true }, owed)
    fail.forget = true
    await settle(['run-chat'], ['reopened'])
    expect(calls).toEqual(moves('run-chat'))
  })

  it('drops the record of a chat open again, or never closed, and moves nothing of it', async () => {
    const owed = new Map([
      ['reopened', 'bot-1'],
      ['not-found', 'bot-1']
    ])
    const { calls, settle } = sessions({ stopped: true }, owed)
    await settle([], ['reopened'])
    expect(calls).toEqual([])
    expect([...owed.keys()]).toEqual(['not-found'])
  })

  it('goes on to the other closed run chats when one cannot be finished', async () => {
    const owed = new Map<string, string>()
    const { calls, settle, throwsFor } = sessions({ stopped: true }, owed)
    const stuck = randomUUID()
    const next = randomUUID()
    owed.set(stuck, 'bot-1').set(next, 'bot-1')
    throwsFor.add(stuck)
    await settle([stuck, next])
    expect(calls).toEqual([...moves(stuck).slice(0, 2), ...moves(next)])
    expect([...owed.keys()]).toEqual([stuck])
  })
})
