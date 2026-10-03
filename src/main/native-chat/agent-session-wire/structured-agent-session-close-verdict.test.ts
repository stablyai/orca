// A turn the host cuts short by closing its provider is the user's cancellation only when the user
// closed this chat. A quit, an idle eviction or a teardown aimed elsewhere leaves it news: the user
// needs to learn it did not finish. The adapter settles its own open turn interrupted, the host's
// fallback settles any turn no adapter did, and both ends read the close's Stop event where the
// row is built: no cause travels with the close.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { describeNativeChatTurnStatus } from '../../../shared/native-chat-turn-status'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { selectStructuredAgentSettledTurns } from '../../../shared/structured-agent-session-turn-timing'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const CUT_TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'cut-turn', ordinal: 1 }

let host: StructuredAgentSessionHost
/** What the provider writes on the open turn as it exits: interrupted at the exit it saw, as both
 *  adapters do, or its own verdict; null writes nothing. */
let providerEnd:
  | 'mapped'
  | Pick<AgentJournalTurnLifecycle, 'state' | 'outcome' | 'completedAt'>
  | null
/** The provider already saw its own exit when the close arrived. */
let exitObservedFirst: boolean
let closeCalls = 0

beforeEach(() => {
  const state = hostTestState()
  providerEnd = 'mapped'
  exitObservedFirst = false
  closeCalls = 0
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store: state.store,
    adapter: {
      ...adapter(),
      closeSession: async () => {
        closeCalls += 1
        const events = state.acquire.mock.calls.at(-1)?.[0].events
        if (providerEnd === null) {
          return true
        }
        // An exit it saw first ended before the close's Stop; a close it made ends after it.
        const end =
          providerEnd === 'mapped'
            ? { state: 'interrupted' as const, completedAt: exitObservedFirst ? 1_500 : Date.now() }
            : providerEnd
        events?.appendItem(
          CUT_TURN,
          {
            kind: 'turn',
            turnId: 'cut-turn',
            startedAt: 1_000,
            requestedAt: 1_000,
            ...end
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return true
      }
    },
    journalDatabase: openTestJournalHostDatabase(state.root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  replaceHostTestState({ store: state.store, host })
})

/** A running turn, anchored to its user row, with a status list watching the session. */
async function runningTurn(): Promise<AgentSessionStatusEvent[]> {
  await attach()
  const events = hostTestState().acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'cut-turn', ordinal: 0 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  events.appendItem(
    CUT_TURN,
    {
      kind: 'turn',
      turnId: 'cut-turn',
      state: 'running',
      startedAt: 1_000,
      requestedAt: 1_000
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
  const statuses: AgentSessionStatusEvent[] = []
  host.subscribeStatus({ id: 'list', emit: (event) => statuses.push(event) })
  return statuses
}

/** What the settle wrote, read back from the journal the next reader opens. */
async function settledTurn() {
  await host.restoreReadableSessions([SESSION])
  const { items } = await host.journalSnapshot(SESSION)
  const turn = items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
  const [settled] = [...selectStructuredAgentSettledTurns(items).values()]
  const label = settled && describeNativeChatTurnStatus({ elapsedSeconds: 0, ...settled }).key
  // Every error row a reader's transcript shows, the cut turn's derived notice included.
  const notices = withNativeChatCutTurnNotices(items, { agentName: 'Codex' }).flatMap((item) =>
    item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : []
  )
  return { turn, settled, label, notices }
}

/** A turn nobody stopped reads like a finished one, with exactly one row saying it stopped. */
const ONE_NOTICE = [
  'Codex stopped while this response was in progress. You can continue in this conversation.'
]

function lastSummary(statuses: AgentSessionStatusEvent[]) {
  const last = statuses.at(-1)
  return last?.type === 'status' ? last.session : null
}

describe('a turn cut short by closing its provider', () => {
  it("records the user's close of this chat as their cancellation", async () => {
    const statuses = await runningTurn()

    await host.close(SESSION, 'user-close')

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
    const { turn, label, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(label).toBe('interruptedAfter')
    // The person's own close explains itself.
    expect(notices).toEqual([])
  })

  it('leaves a close the user did not aim at this chat as news', async () => {
    const statuses = await runningTurn()

    // What an idle eviction, a worktree teardown or an orchestration stop issues.
    await host.close(SESSION, 'evict')

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
    const { turn, label, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    // News for the sidebar; the turn reads like a finished one beside its one notice.
    expect(label).toBe('workedFor')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it("records the user's close on a turn no adapter settled, through the host's fallback", async () => {
    providerEnd = null
    const statuses = await runningTurn()

    await host.close(SESSION, 'user-close')

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it("records the user's close on a turn whose start landed only as the provider stopped", async () => {
    // The provider opened the turn, but its rows are still in the event sink when the close
    // arrives: the journal has no turn yet.
    await attach()
    await host.flushStreamedEvents(SESSION)
    const events = hostTestState().acquire.mock.calls[0]?.[0].events
    events?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'cut-turn', ordinal: 0 },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    events?.appendItem(
      CUT_TURN,
      { kind: 'turn', turnId: 'cut-turn', state: 'running', startedAt: 1_000, requestedAt: 1_000 },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it('leaves a turn cut off before the close as news', async () => {
    providerEnd = null
    await attach()
    const events = hostTestState().acquire.mock.calls[0]?.[0].events
    // An earlier death the user already saw as Interrupted, then closed.
    events?.appendItem(
      CUT_TURN,
      {
        kind: 'turn',
        turnId: 'cut-turn',
        state: 'interrupted',
        startedAt: 1_000,
        requestedAt: 1_000,
        completedAt: 1_200
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(SESSION)

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', completedAt: 1_200 })
    expect(turn).not.toHaveProperty('outcome')
  })

  it('keeps a turn the provider finished during the stop as finished', async () => {
    providerEnd = { state: 'completed', outcome: 'success', completedAt: 1_500 }
    await runningTurn()

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'completed', outcome: 'success' })
  })

  it('keeps a verdict the provider gave on its way out', async () => {
    // How Codex records a turn it reports failed.
    providerEnd = { state: 'interrupted', outcome: 'failure', completedAt: 1_500 }
    await runningTurn()

    await host.close(SESSION, 'user-close')

    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'failure' })
  })

  it('leaves a quit as news', async () => {
    const statuses = await runningTurn()

    await host.flushAllStreamedEvents({ trigger: 'quit' })

    expect(statuses.findLast((event) => event.type === 'status')).toMatchObject({
      session: { status: 'idle', turnOutcome: 'interruption' }
    })
    const { label, notices } = await settledTurn()
    expect(label).toBe('workedFor')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it("keeps the user's cancellation when a close aborts after the provider settled, then retries", async () => {
    await runningTurn()
    const sink = host['runtimeState'].eventSinkFor(SESSION)
    const drained = sink.drained.bind(sink)
    let failed = false
    vi.spyOn(sink, 'drained').mockImplementation(async () => {
      if (closeCalls > 0 && !failed) {
        failed = true
        return { ok: false, error: new Error('drain failed') }
      }
      return drained()
    })
    // The adapter settled the turn, then the close aborted at the drain after it.
    await expect(host.close(SESSION, 'user-close')).rejects.toThrow()
    expect(closeCalls).toBe(1)
    await host.close(SESSION, 'user-close')
    const { turn } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it.each([
    ['user-close', { outcome: 'cancellation' }],
    ['evict', { outcome: undefined }]
  ] as const)(
    "keeps a %s's cause when the idle sweep finishes a wind-down it could not",
    async (cause, verdict) => {
      providerEnd = null
      await runningTurn()
      const sink = host['runtimeState'].eventSinkFor(SESSION)
      const drained = sink.drained.bind(sink)
      let failed = false
      vi.spyOn(sink, 'drained').mockImplementation(async () => {
        if (closeCalls > 0 && !failed) {
          failed = true
          return { ok: false, error: new Error('drain failed') }
        }
        return drained()
      })
      // The provider is proven gone, then the close aborts before the host settles its turn.
      await expect(host.close(SESSION, cause)).rejects.toThrow()

      await host.collaboratorsForTests().lifetime.idleSweep.tick()

      expect(closeCalls).toBe(1)
      const { turn, notices } = await settledTurn()
      expect(turn).toMatchObject({ state: 'interrupted' })
      expect(turn?.outcome).toBe(verdict.outcome)
      expect(notices).toEqual(cause === 'evict' ? ONE_NOTICE : [])
    }
  )

  it("leaves a quit's cut on a turn no adapter settled as news", async () => {
    providerEnd = null
    await runningTurn()

    await host.flushAllStreamedEvents({ trigger: 'quit' })

    const { turn, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it('leaves a crash the provider saw before the user closed the chat as news', async () => {
    exitObservedFirst = true
    await runningTurn()
    // The provider reports its own exit, which it saw first, as it closes: no verdict.
    await host.close(SESSION, 'user-close')
    const { turn, notices } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(notices).toEqual(ONE_NOTICE)
  })

  it.each(['user-close', 'evict'] as const)(
    'closes the conversation of a chat a %s ends, as any close does',
    async (cause) => {
      await runningTurn()

      await host.close(SESSION, cause)

      expect(host.hasSession(SESSION)).toBe(false)
    }
  )
})
