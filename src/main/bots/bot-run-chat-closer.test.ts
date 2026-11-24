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
  readBotChats: async () => chats.rows
}))

const world = vi.hoisted(() => {
  const closeCalls: string[] = []
  return {
    journals: new Map<string, { first: unknown; last: unknown }>(),
    working: new Set<string>(),
    tabs: new Set<string>(),
    closeCalls,
    /** Runs before the recheck under the lock, as mail arriving meanwhile would. */
    beforeRecheck: () => {}
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
vi.mock('./bot-session-tabs', () => ({ botOfSession: () => null }))
vi.mock('./bot-chat-session', () => ({
  requireStructuredHost: async () => ({
    journalReads: async (id: string) => ({
      promptItem: async (end: 'first' | 'last') => world.journals.get(id)?.[end] ?? null
    }),
    getSessionTabId: (id: string) => (world.tabs.has(id) ? 'tab' : null)
  })
}))
vi.mock('./bot-run-chat-close-step', () => ({
  runtimeRunChatClose:
    () => async (_botId: string, sessionId: string, ended: () => Promise<boolean>) => {
      world.beforeRecheck()
      if (!(await ended())) {
        return 'kept'
      }
      world.closeCalls.push(sessionId)
      chats.rows = chats.rows.filter((row) => row.id !== sessionId)
      return 'closed'
    }
}))

const { bindRunChatChecks, closeEndedRunChats, previewRunChats } =
  await import('./bot-run-chat-closer')
// The real lock and close order; the closer above reads mocked ones.
const { botChatSessions } = await vi.importActual<ChatSessionModule>('./bot-chat-session')
const { closeRunChatUnderLock } = await vi.importActual<CloseStepModule>(
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
        list: async ({ chatIds }: { chatIds: string[] }) => ({
          items: fixture.items.filter((item) => chatIds.includes(item.chatId)),
          counts: {}
        })
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
  world.journals.set(id, { first: runMessage(`run-${id}`), last: runMessage(`run-${id}`) })
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
    world.journals.set(person, { first: { itemId: 'p', body: { kind: 'message' } }, last: null })
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
        (world.journals.get(id)!.last = { itemId: 'typed', body: { kind: 'message' } })
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
})

describe('closing one run chat under the bot lock', () => {
  function sessions(closed: { stopped: boolean }) {
    const calls: string[] = []
    const host = {
      deps: {
        store: {
          getConversation: (id: string) =>
            id === 'home-chat' ? { provider: 'codex', sessionId: 'home-chat' } : null
        }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat lock reads only these fields of the bot.
    const bot = { id: 'bot-1', agent: 'codex', chatSessionId: 'home-chat' } as Bot
    const chats = botChatSessions({
      bots: { list: () => [bot], setChatSession: async () => bot },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opening Home Chat reads only the store's conversation.
      host: async () => host as never,
      createChat: async () => {},
      showTab: async () => {},
      closeChat: async () => ({ stopped: true }),
      dropUnreadMail: async () => {}
    })
    const close = (sessionId: string, ended: boolean) =>
      closeRunChatUnderLock(
        chats,
        {
          close: async (id) => {
            calls.push(`close ${id}`)
            return closed
          },
          carry: async (_host, from, to) => {
            calls.push(`carry ${from} -> ${to}`)
          },
          handOver: (from, to) => calls.push(`hand over ${from} -> ${to}`),
          dropUnreadMail: async (_bot, from) => {
            calls.push(`drop ${from}`)
          }
        },
        'bot-1',
        sessionId,
        async () => ended
      )
    return { calls, close }
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

  it('leaves the chat and its mail alone when the recheck keeps it or the close is refused', async () => {
    const kept = sessions({ stopped: true })
    await expect(kept.close('run-chat', false)).resolves.toBe('kept')
    await expect(kept.close('home-chat', true)).resolves.toBe('kept')
    expect(kept.calls).toEqual([])

    const refused = sessions({ stopped: false })
    await expect(refused.close('run-chat', true)).resolves.toBe('failed')
    expect(refused.calls).toEqual(['close run-chat'])
  })
})
