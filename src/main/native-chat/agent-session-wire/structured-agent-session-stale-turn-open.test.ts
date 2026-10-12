// A turn an exited agent left running, whose settlement write failed, is settled by the chat's
// retry once storage takes it, or by the next startup. A reader opening the chat
// in between writes nothing, and the turn holds nothing: it is an ended generation's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import {
  collectSubscriber,
  createRestTestRig,
  foundRestTestChat,
  IDLE_MS,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD,
  sweepOnce,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { retryIdle, retryOwes } from './structured-agent-session-retry.test-fixture'

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

/** A turn in flight whose agent exits, and whose exit settlement the journal refuses. */
async function exitWithUnwrittenSettlement(refusedWrites = 1): Promise<void> {
  await foundRestTestChat(rig)
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)!
  const running = open.child!
  rig.adapter.acquire.mock.calls
    .at(-1)?.[0]
    .events?.appendItem(
      { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'working', ordinal: 50 },
      { kind: 'turn', turnId: 'working', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await rig.host.flushStreamedEvents(SESSION)
  const append = vi.spyOn(open.journal, 'appendPlannedLifecycleBatch')
  for (let refused = 0; refused < refusedWrites; refused += 1) {
    append.mockRejectedValueOnce(new Error('disk full'))
  }
  await rig.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    reason: 'killed',
    cause: 'unexpected-exit',
    fence: running.fence,
    acquisitionGeneration: running.generation!
  })
  await vi.waitFor(() =>
    expect(rig.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed' }
    })
  )
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
}

async function workingTurnState(): Promise<string | undefined> {
  const items = (await rig.host.journalSnapshot(SESSION)).items
  return items
    .map((item) => readAgentJournalTurn(item.body))
    .find((turn) => turn?.turnId === 'working')?.state
}

describe('a turn its gone agent left running', () => {
  it('is settled in place by the exit, with no reopen', async () => {
    await exitWithUnwrittenSettlement(0)

    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(true)
    expect(await workingTurnState()).toBe('interrupted')
    const { items } = await rig.host.journalSnapshot(SESSION)
    expect(JSON.stringify(items)).toContain(
      'Codex stopped while this response was in progress. You can continue in this conversation.'
    )
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })

  it('is settled by the host retry once storage takes the write, with no send; a reader writes nothing meanwhile', async () => {
    // The exit's own write and the retry's first attempt both fail; the backoff's retry lands.
    await exitWithUnwrittenSettlement(2)
    const { reconciliation } = rig.host.collaboratorsForTests()
    await retryIdle(reconciliation, SESSION)
    expect(retryOwes(reconciliation, SESSION)).toBe(true)
    expect(await workingTurnState()).toBe('running')
    const cursor = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal.cursor()

    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal.cursor()).toEqual(cursor)

    await vi.waitFor(async () => expect(await workingTurnState()).toBe('interrupted'), {
      timeout: 5_000
    })
    // The death evidence is Orca's log text: the row says only that the provider stopped.
    expect(JSON.stringify(reader.events)).toContain(
      'Codex stopped while this response was in progress. You can continue in this conversation.'
    )
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
    // Nothing owed once it landed: the idle sweep closes the chat as it would any other.
    await retryIdle(reconciliation, SESSION)
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
  })

  it('is settled by the startup after a restart, even when a read reaches the chat first', async () => {
    // Storage refuses it for the rest of this process.
    await exitWithUnwrittenSettlement(100)
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)

    // The client's read opens the chat first and writes nothing.
    expect(await workingTurnState()).toBe('running')
    await rig.host.reconcileRestartLeases()
    await rig.host.startupSettled()
    expect(await workingTurnState()).toBe('interrupted')
    await rig.host.restoreReadableSessions([SESSION])
    expect(await workingTurnState()).toBe('interrupted')
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })
})
