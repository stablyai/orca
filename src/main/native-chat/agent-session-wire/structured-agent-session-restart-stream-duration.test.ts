import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentTurnTimings
} from '../../../shared/structured-agent-session-turn-timing'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'
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
const TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'stream-turn', ordinal: 0 }
const REPLY = { ...TURN, ordinal: 1 }
const TURN_SCOPE = { kind: 'turn' as const, turnItemId: agentJournalItemKey(TURN) }

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

async function streamBeforeCrash(
  workspaceKind: 'folder' | 'git-worktree' = 'git-worktree'
): Promise<void> {
  const attached = await rig.host.attach(
    REST_TEST_CALLER,
    hostTestAttachParams(null, { location: { ...HOST_TEST_LOCATION, workspaceKind } })
  )
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
      { turnScope: TURN_SCOPE, observedAt: HOST_TEST_NOW + chunk * 500 }
    )
    await rig.host.flushStreamedEvents(SESSION)
  }
  expect(rig.store.getRecord(SESSION)?.lease.lastRenewedAt).toBe(HOST_TEST_NOW)
}

/** Drops the old host without an exit callback or graceful turn settlement. */
async function restartAfterCrash(): Promise<void> {
  const old = rig.host
  old.stopDelivery()
  const { lifetime, runtimeState, sessions } = old.collaboratorsForTests()
  lifetime.idleSweep.dispose()
  await runtimeState.stopLeaseRenewal()
  runtimeState.currentEventSink(SESSION)?.close()
  await sessions.get(SESSION)?.journal.close()
  closeTestJournalHostDatabases()
  rig.clock.now = RESTARTED_AT
  rig.store = await openTestAgentSessionRecordStore(rig.root)
  rig.host = new StructuredAgentSessionHost({
    ...old.deps,
    store: rig.store,
    journalDatabase: openTestJournalHostDatabase(rig.root),
    now: () => RESTARTED_AT
  })
}

async function expectSettledStream(): Promise<void> {
  const snapshot = await rig.host.journalSnapshot(SESSION)
  expect(
    snapshot.items.find((item) => item.itemId === agentJournalItemKey(REPLY))?.body
  ).toMatchObject({
    kind: 'message',
    blocks: [{ type: 'text', text: 'chunks 1-11' }]
  })
  const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
  expect(turn).toMatchObject({ state: 'interrupted', completedAt: LAST_CHUNK_AT })
  const [timing] = selectStructuredAgentTurnTimings(snapshot.items).values()
  expect(completedStructuredAgentTurnSeconds(timing)).toBe(5)
  expect(
    withNativeChatCutTurnNotices(snapshot.items, { agentName: 'Codex' }).filter(
      (item) => item.body.kind === 'status' && item.body.text !== 'host notice'
    )
  ).toHaveLength(1)
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
}

describe('a provider stream cut short before its next lease renewal', () => {
  it.each(['git-worktree', 'folder'] as const)(
    'settles and replays the duration exactly once in a %s workspace',
    async (workspaceKind) => {
      await streamBeforeCrash(workspaceKind)
      const cursor = (await rig.host.journalSnapshot(SESSION)).cursor
      await restartAfterCrash()
      await rig.host.restoreReadableSessions()

      await expectSettledStream()
      const events: AgentSessionSubscribeEvent[] = []
      const unsubscribe = await rig.host.subscribe({
        id: 'reconnecting-client',
        sessionId: SESSION,
        cursor,
        emit: (event) => events.push(event)
      })
      const replayedTurns = events.flatMap((event) => {
        const items =
          event.type === 'snapshot'
            ? event.page.items
            : event.type === 'batch'
              ? event.batch.items
              : []
        return items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
      })
      expect(replayedTurns).toEqual([
        expect.objectContaining({ state: 'interrupted', completedAt: LAST_CHUNK_AT })
      ])
      unsubscribe()
      const settled = await rig.host.journalSnapshot(SESSION)
      await rig.host.restoreReadableSessions()
      expect(await rig.host.journalSnapshot(SESSION)).toEqual(settled)

      await restartAfterCrash()
      await rig.host.restoreReadableSessions()
      await expectSettledStream()
      // A reopen can mark its queue, but never revises the settled turn again.
      expect((await rig.host.journalSnapshot(SESSION)).items).toEqual(settled.items)
    }
  )

  it('retains the output bound when a client opens the journal before owner reconciliation', async () => {
    await streamBeforeCrash()
    await restartAfterCrash()
    const beforeProof = await rig.host.journalSnapshot(SESSION)
    expect(
      beforeProof.items.some((item) => readAgentJournalTurn(item.body)?.state === 'unverifiable')
    ).toBe(true)

    await rig.host.reconcileRestartLeases()
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})

    await expectSettledStream()
  })

  it('also preserves the interrupted turn and duration after a local desktop quit', async () => {
    await streamBeforeCrash()
    rig.clock.now = LAST_CHUNK_AT
    await rig.host.flushAllStreamedEvents({ trigger: 'quit' })
    await restartAfterCrash()
    await rig.host.restoreReadableSessions()

    await expectSettledStream()
    expect(rig.adapter.closeSession).toHaveBeenCalledOnce()
  })

  // A new server replacing the owner's runtime ends it anyway (structured-agent-session-replaced-server-turn).
  it('leaves the end unverifiable when its own runtime reopens and cannot prove owner death', async () => {
    await streamBeforeCrash()
    await restartAfterCrash()
    rig.host.deps.probeOwner = async () => ({
      outcome: 'indeterminate',
      reason: 'probe unavailable'
    })
    await rig.host.restoreReadableSessions()

    const snapshot = await rig.host.journalSnapshot(SESSION)
    const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
    expect(turn?.state).toBe('unverifiable')
    expect(turn?.completedAt).toBeUndefined()
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })

  it('ignores later client actions, recovery revisions, and another owner generation', async () => {
    await streamBeforeCrash()
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
    if (!journal) {
      throw new Error('the streaming journal is not open')
    }
    const later = RESTARTED_AT - 1_000
    rig.clock.now = later
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'late-client-send' },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next task' }] },
      { fence: 1, turnScope: TURN_SCOPE, observedAt: later }
    )
    await journal.appendItem(
      { ...REPLY, ordinal: 2 },
      {
        kind: 'approval',
        title: 'Run?',
        detail: null,
        options: [],
        resolution: {
          state: 'resolved',
          selectedOptionId: 'allow',
          resolvedBy: 'client',
          resolvedAt: later
        }
      },
      { fence: 1, turnScope: TURN_SCOPE, observedAt: later }
    )
    const originalReply = journal.itemBody(agentJournalItemKey(REPLY))
    if (!originalReply) {
      throw new Error('the streamed reply is missing')
    }
    await journal.appendLifecycleBatch({
      settlementId: 'earlier-read-recovery',
      fence: 1,
      recovered: true,
      mutations: [{ kind: 'item', identity: REPLY, body: originalReply, turnScope: TURN_SCOPE }]
    })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'late-host-notice' },
      { kind: 'status', text: 'host notice' },
      { fence: 1, turnScope: TURN_SCOPE }
    )
    await journal.appendItem(
      { ...REPLY, ordinal: 3 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'another owner' }] },
      { fence: 2, turnScope: TURN_SCOPE, observedAt: later }
    )
    await restartAfterCrash()
    await rig.host.restoreReadableSessions()

    await expectSettledStream()
  })
})
