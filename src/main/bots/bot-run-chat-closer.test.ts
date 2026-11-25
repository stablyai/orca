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
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type * as ChatSessions from './bot-chat-session'
import type * as CloseStep from './bot-run-chat-close-step'

type ChatSessionModule = typeof ChatSessions
type CloseStepModule = typeof CloseStep

const chats = vi.hoisted(() => {
  const rows: BotChatRow[] = []
  return { rows }
})
vi.mock('../runtime/rpc/methods/bots-chats', () => ({
  readBotChats: async () => chats.rows
}))

const world = vi.hoisted(() => {
  const closeCalls: string[] = []
  const noBot = (): Bot | null => null
  return {
    journals: new Map<string, { first: unknown; 'last-person': unknown }>(),
    working: new Set<string>(),
    tabs: new Set<string>(),
    closeCalls,
    /** Runs before the recheck under the lock, as mail arriving meanwhile would. */
    beforeRecheck: () => {},
    /** The bot a session's chat is in, as the per-run timer finds it. */
    sessionBot: noBot()
  }
})
vi.mock('../external-conversations/external-conversation-chat', () => ({
  chatIsIdle: (_host: unknown, id: string) => !world.working.has(id),
  chatPaneKey: (id: string) => `pane:${id}`
}))
vi.mock('../runtime/orchestration/addressing/session-lineage/structured-session-lineage', () => ({
  readAgentSessionRecordStore: () => null,
  lineageLiveSession: () => null
}))
vi.mock('./bot-session-tabs', () => ({ botOfSession: () => world.sessionBot }))
vi.mock('./bot-chat-session', () => ({
  requireStructuredHost: async () => ({
    journalReads: async (id: string) => ({
      promptItem: async (end: 'first' | 'last-person') => world.journals.get(id)?.[end] ?? null
    }),
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
      world.closeCalls.push(sessionId)
      chats.rows = chats.rows.filter((row) => row.id !== sessionId)
      return 'closed'
    },
    settle: async () => {}
  })
}))

const { bindRunChatChecks, closeEndedRunChats, previewRunChats, scheduleRunChatCheck } =
  await import('./bot-run-chat-closer')
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
  world.journals.set(id, { first: runMessage(`run-${id}`), 'last-person': null })
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
    expect(preview).toMatchObject({ open: 3, notRunChats: 2, keep: [] })
    expect(preview.close.map((chat) => chat.chatId)).toEqual([ended])

    await expect(closeEndedRunChats(runtime, bot)).resolves.toMatchObject({ closed: 1, failed: 0 })
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
        fixture.automations.push({ bot: { botId: 'bot-1', chat: { sessionId: id } } }),
      thread: (id) => fixture.threads.add(`pane:${id}`),
      'live-run': (id) => fixture.liveRuns.add(id),
      'tab-open': (id) => world.tabs.add(id),
      'person-spoke': (id) =>
        (world.journals.get(id)!['last-person'] = { itemId: 'typed', body: { kind: 'message' } })
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
      expect.objectContaining({ chatId: doneItem, items: [{ number: 11, status: 'done' }] })
    ])
    expect(preview.itemMailTo).toEqual({ chatId: 'home-chat', title: 'a chat' })
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
  })

  it('does nothing while the setting is off', async () => {
    const { bot, runtime } = setup({ closeEndedRuns: undefined })
    runChat()
    await expect(closeEndedRunChats(runtime, bot)).resolves.toBeNull()
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
  })
})

describe('closing one run chat under the bot lock', () => {
  function sessions(closed: { stopped: boolean }) {
    const calls: string[] = []
    const fail = { home: false, carry: false, handOver: false }
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
      carry: async (_host, from, to) => {
        if (fail.carry) {
          throw new Error('carry failed')
        }
        calls.push(`carry ${from} -> ${to}`)
      },
      handOver: (from, to) => {
        if (fail.handOver) {
          throw new Error('hand over failed')
        }
        calls.push(`hand over ${from} -> ${to}`)
      },
      dropUnreadMail: async (_bot, from) => {
        calls.push(`drop ${from}`)
      }
    }
    const close = (sessionId: string, ended: boolean) =>
      closeRunChatUnderLock(chats, steps, 'bot-1', sessionId, async () => ended)
    /** The next look at the bot's closed run chats; `coordinating` are those a Run is bound to. */
    const settle = (closedChats: string[], coordinating: string[] = []) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the look reads only the Runs that name a chat.
      const db = {
        db: { prepare: () => ({ all: () => coordinating.map((id) => ({ id })) }) },
        runsBoundToCoordinator: ({ orcaSessionId }: { orcaSessionId: string }) =>
          coordinating.includes(orcaSessionId) ? [{ id: 'run-1' }] : []
      } as unknown as OrchestrationDb
      const closedRows = closedChats.map((id) => ({ chatId: id, sessionId: id }))
      return settleClosedRunChats(chats, steps, db, 'bot-1', closedRows, async () => true)
    }
    return { calls, close, settle, fail, bot }
  }

  it('closes, then moves what was queued and coordinated there to the Home Chat', async () => {
    const { calls, close } = sessions({ stopped: true })
    await expect(close('run-chat', true)).resolves.toBe('closed')
    expect(calls).toEqual([
      'close run-chat',
      'carry run-chat -> home-chat',
      'hand over run-chat -> home-chat',
      'drop run-chat'
    ])
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
  })

  it('leaves the run chat open when the Home Chat cannot open', async () => {
    const { calls, close, fail } = sessions({ stopped: true })
    fail.home = true
    await expect(close('run-chat', true)).rejects.toThrow('no Home Chat')
    expect(calls).toEqual([])
  })

  it('moves what a failed move left on a closed run chat on a later look', async () => {
    const { calls, close, settle, fail } = sessions({ stopped: true })
    const carried = randomUUID()
    fail.carry = true
    await expect(close(carried, true)).resolves.toBe('closed')
    // The Runs still moved, and the cards wait for the next look.
    expect(calls).toEqual([
      `close ${carried}`,
      `hand over ${carried} -> home-chat`,
      `drop ${carried}`
    ])
    fail.carry = false
    calls.length = 0
    await settle([carried, randomUUID()])
    expect(calls).toEqual([`carry ${carried} -> home-chat`, `hand over ${carried} -> home-chat`])
    calls.length = 0
    await settle([carried])
    expect(calls).toEqual([])

    // A Run still bound to a closed run chat is found from the Runs, as after a restart.
    const coordinating = randomUUID()
    await settle([coordinating], [coordinating])
    expect(calls).toEqual([
      `carry ${coordinating} -> home-chat`,
      `hand over ${coordinating} -> home-chat`
    ])
  })
})
