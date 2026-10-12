import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentTurnTimings
} from '../../../shared/structured-agent-session-turn-timing'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { beginAgentSessionRuntimeIncarnationForTest } from '../../runtime/agent-session-runtime-attribution'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { HOST_TEST_NOW, hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { retryIdle } from './structured-agent-session-retry.test-fixture'

const LAST_CHUNK_AT = HOST_TEST_NOW + 5_500
const RESTARTED_AT = HOST_TEST_NOW + 3_600_000
const CUT_REPLY = 'chunks 1-11'
const TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'cut-turn', ordinal: 0 }
const REPLY = { ...TURN, ordinal: 1 }
const NEXT_TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'next-turn', ordinal: 2 }
const NEXT_REPLY = { ...NEXT_TURN, ordinal: 3 }
// The provider's identity cannot be proven either way: the recovery releases it with no proof.
const UNPROVABLE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'probe unavailable' }

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  vi.spyOn(Date, 'now').mockImplementation(() => rig.clock.now)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
  closeTestJournalHostDatabases()
})

async function streamThenServerKilled(): Promise<void> {
  const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
  if (!attached.ok) {
    throw new Error(`attach refused: ${attached.refusal.code}`)
  }
  const sent = await rig.host.send(REST_TEST_CALLER, restTestSend('long stream', attached.fence))
  if (!sent.ok) {
    throw new Error(`send refused: ${sent.refusal.code}`)
  }
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  const events = rig.adapter.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('the provider has no event sink')
  }
  events.appendItem(
    TURN,
    { kind: 'turn', turnId: TURN.turnId, state: 'running', startedAt: HOST_TEST_NOW },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE, observedAt: HOST_TEST_NOW }
  )
  for (let chunk = 1; chunk <= 11; chunk += 1) {
    rig.clock.now = HOST_TEST_NOW + chunk * 500
    events.appendItem(
      REPLY,
      {
        kind: 'message',
        role: 'assistant',
        state: 'running',
        blocks: [{ type: 'text', text: `chunks 1-${chunk}` }]
      },
      {
        turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(TURN) },
        observedAt: HOST_TEST_NOW + chunk * 500
      }
    )
    await rig.host.flushStreamedEvents(SESSION)
  }
}

/** The server dies with no exit seen and no settle; a server process starts on the same host. */
async function startServer(options: { newProcess: boolean }): Promise<void> {
  const old = rig.host
  old.stopDelivery()
  const { lifetime, runtimeState, sessions } = old.collaboratorsForTests()
  lifetime.idleSweep.dispose()
  await runtimeState.stopLeaseRenewal()
  runtimeState.currentEventSink(SESSION)?.close()
  await sessions.get(SESSION)?.journal.close()
  closeTestJournalHostDatabases()
  if (options.newProcess) {
    beginAgentSessionRuntimeIncarnationForTest()
  }
  rig.clock.now = RESTARTED_AT
  rig.store = await openTestAgentSessionRecordStore(rig.root)
  rig.host = new StructuredAgentSessionHost({
    ...old.deps,
    store: rig.store,
    journalDatabase: openTestJournalHostDatabase(rig.root),
    probeOwner: async () => UNPROVABLE,
    now: () => rig.clock.now
  })
}

/** Startup as the runtime runs it: the lease reconcile, the retry's settlement, the visible tabs. */
async function startUp(): Promise<void> {
  await rig.host.reconcileRestartLeases()
  await rig.host.startupSettled()
  await settled()
  await rig.host.restoreReadableSessions()
  await settled()
}

function settled(): Promise<void> {
  return retryIdle(rig.host.collaboratorsForTests().reconciliation, SESSION)
}

function turnsOf(items: readonly AgentJournalRenderItem[]) {
  return items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
}

function repliesOf(items: readonly AgentJournalRenderItem[]): string[] {
  return items.flatMap((item) =>
    item.body.kind === 'message' && item.body.role === 'assistant'
      ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}

function stopNotices(items: readonly AgentJournalRenderItem[]): AgentJournalRenderItem[] {
  return withNativeChatCutTurnNotices(items, { agentName: 'Codex' }).filter(
    (item) => item.body.kind === 'status'
  )
}

async function expectCutTurnSettledOnce(): Promise<void> {
  const { items } = await rig.host.journalSnapshot(SESSION)
  const cut = turnsOf(items).find((turn) => turn.turnId === TURN.turnId)
  expect(cut).toMatchObject({ state: 'interrupted', completedAt: LAST_CHUNK_AT })
  const [timing] = selectStructuredAgentTurnTimings(items).values()
  expect(completedStructuredAgentTurnSeconds(timing)).toBe(5)
  expect(repliesOf(items).filter((text) => text === CUT_REPLY)).toHaveLength(1)
  expect(stopNotices(items)).toHaveLength(1)
}

describe('a server replaced mid-turn on the same execution host', () => {
  it('interrupts the cut turn at its last saved output with no provider identity left', async () => {
    await streamThenServerKilled()
    await startServer({ newProcess: true })
    // Settled at startup, not on open.
    await startUp()
    await expectCutTurnSettledOnce()

    await rig.host.reconcileRestartLeases()
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
    // Nothing proved the provider gone: the lease keeps no death and no identity.
    const lease = rig.store.getRecord(SESSION)?.lease
    expect(lease).toMatchObject({ claimStatus: 'released', deathEvidence: null })
    expect(lease?.ownerProcess).toBeNull()
    await expectCutTurnSettledOnce()

    const attached = await rig.host.attach(
      REST_TEST_CALLER,
      hostTestAttachParams(lease?.runtimeFence ?? null)
    )
    if (!attached.ok) {
      throw new Error(`re-attach refused: ${attached.refusal.code}`)
    }
    const sent = await rig.host.send(
      REST_TEST_CALLER,
      restTestSend('after restart', attached.fence)
    )
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    const events = rig.adapter.acquire.mock.calls[1]?.[0].events
    if (!events) {
      throw new Error('the new provider has no event sink')
    }
    events.appendItem(
      NEXT_TURN,
      { kind: 'turn', turnId: NEXT_TURN.turnId, state: 'running', startedAt: RESTARTED_AT },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, observedAt: RESTARTED_AT }
    )
    events.appendItem(
      NEXT_REPLY,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'fresh reply' }] },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(NEXT_TURN) } }
    )
    events.appendItem(
      NEXT_TURN,
      {
        kind: 'turn',
        turnId: NEXT_TURN.turnId,
        state: 'completed',
        startedAt: RESTARTED_AT,
        completedAt: RESTARTED_AT + 1_000
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)

    await expectCutTurnSettledOnce()
    const { items } = await rig.host.journalSnapshot(SESSION)
    expect(turnsOf(items).map((turn) => turn.state)).toEqual(['interrupted', 'completed'])
    expect(repliesOf(items)).toEqual([CUT_REPLY, 'fresh reply'])
  })

  it('revises a turn an earlier start left unverifiable once a new server replaces its owner', async () => {
    await streamThenServerKilled()
    // The same process reopening its store replaced no runtime: nothing proves the turn over.
    await startServer({ newProcess: false })
    await startUp()
    const left = turnsOf((await rig.host.journalSnapshot(SESSION)).items)
    expect(left).toEqual([expect.objectContaining({ state: 'unverifiable' })])

    // Healed at startup, not on open.
    await startServer({ newProcess: true })
    await startUp()
    await expectCutTurnSettledOnce()

    const healed = await rig.host.journalSnapshot(SESSION)
    await startServer({ newProcess: true })
    await startUp()
    expect((await rig.host.journalSnapshot(SESSION)).items).toEqual(healed.items)
  })
})

// No write on open: before the startup lease check, the projection derives the end from the
// runtime this one replaced; the startup pass then settles it, even under a recovery latch.
describe('a chat whose turn a replaced server held, before anything settles it', () => {
  it('reads its cut turn interrupted when opened before the startup lease check', async () => {
    await streamThenServerKilled()
    await startServer({ newProcess: true })

    const { page } = await rig.host.history({ sessionId: SESSION, direction: 'tail' })

    expect(page.latestTurn?.turn).toMatchObject({ turnId: TURN.turnId, state: 'interrupted' })
    expect(page.working).toBe(false)
    // Derived, not written: the journal holds the turn as the crash left it.
    const { items } = await rig.host.journalSnapshot(SESSION)
    expect(turnsOf(items)).toEqual([expect.objectContaining({ state: 'running' })])
  })

  /** Its agent outlived the server; startup runs with no tab showing the chat. */
  async function survivingOwnerStartup(newProcess: boolean) {
    await streamThenServerKilled()
    await startServer({ newProcess })
    let alive = true
    rig.host.deps.probeOwner = async () =>
      alive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' }
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })
    rig.host.deps.stopOwnerProcess = stopOwnerProcess
    await rig.host.reconcileRestartLeases()
    await rig.host.startupSettled()
    await settled()
    const lease = rig.store.getRecord(SESSION)?.lease
    expect(lease?.handoffStage).toBe('recovering')
    return { stopOwnerProcess, lease }
  }

  it('reads settled from history after startup, with no send or attach, and its next send starts a new agent', async () => {
    const { stopOwnerProcess, lease } = await survivingOwnerStartup(true)

    await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    await expectCutTurnSettledOnce()
    // The settle stopped no process and left the recovery's lease as it was.
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)?.lease).toEqual(lease)

    // The attach resolves the recovery first, which moves the fence it expected.
    const stale = await rig.host.attach(
      REST_TEST_CALLER,
      hostTestAttachParams(lease?.runtimeFence ?? null)
    )
    const attached = stale.ok
      ? stale
      : await rig.host.attach(
          REST_TEST_CALLER,
          hostTestAttachParams(stale.refusal.currentFence ?? null)
        )
    if (!attached.ok) {
      throw new Error(`attach refused: ${attached.refusal.code}`)
    }
    const sent = await rig.host.send(
      REST_TEST_CALLER,
      restTestSend('after restart', attached.fence)
    )
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  })

  it('reads unverifiable and not working while its owner recovers with no child here', async () => {
    await survivingOwnerStartup(false)

    const { page } = await rig.host.history({ sessionId: SESSION, direction: 'tail' })

    expect(page.working).toBe(false)
    expect(page.latestTurn?.turn).toMatchObject({ turnId: TURN.turnId, state: 'unverifiable' })
    expect(rig.host.currentWork(SESSION)?.working()).toBe(false)
  })

  it('settles nothing and stops nothing with no runtime replaced, while its recovery waits', async () => {
    const { stopOwnerProcess, lease } = await survivingOwnerStartup(false)

    const { items } = await rig.host.journalSnapshot(SESSION)
    expect(turnsOf(items)).toEqual([expect.objectContaining({ state: 'running' })])
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(rig.store.getRecord(SESSION)?.lease).toEqual(lease)
  })
})
