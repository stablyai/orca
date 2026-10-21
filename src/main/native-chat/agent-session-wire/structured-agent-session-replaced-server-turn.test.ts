import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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
import {
  openStructuredAgentSessionConversationJournal,
  type StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'
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
    await rig.host.restoreReadableSessions()
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
    await rig.host.restoreReadableSessions()
    await rig.host.reconcileRestartLeases()
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
    const left = turnsOf((await rig.host.journalSnapshot(SESSION)).items)
    expect(left).toEqual([expect.objectContaining({ state: 'unverifiable' })])

    await startServer({ newProcess: true })
    await rig.host.restoreReadableSessions()
    await expectCutTurnSettledOnce()

    const settled = await rig.host.journalSnapshot(SESSION)
    await startServer({ newProcess: true })
    await rig.host.restoreReadableSessions()
    expect((await rig.host.journalSnapshot(SESSION)).items).toEqual(settled.items)
  })

  it('only lets an acquisition open a journal without the store', () => {
    const open = (
      deps: Omit<StructuredAgentSessionConversationOpenDeps, 'store'>,
      record: AgentSessionRecord
    ) => {
      void openStructuredAgentSessionConversationJournal(deps, record, { acquisition: true })
      // @ts-expect-error a reader open settles, so without the store its turns would stay unverifiable
      void openStructuredAgentSessionConversationJournal(deps, record)
    }
    expect(open).toBeTypeOf('function')
  })
})
