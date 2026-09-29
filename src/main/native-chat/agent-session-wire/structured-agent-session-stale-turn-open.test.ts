// A turn an exited agent left running, whose settlement write failed, is settled by the next open of
// the conversation, not only by the next send: a reader reopening a chat the idle sweep closed, or
// reading it before the restart restore reaches it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

/** A turn in flight whose agent exits, and whose exit settlement the journal refuses: by default
 *  also the retry that recording the exit queues, so only an open is left to settle it. */
async function exitWithUnwrittenSettlement(refusedWrites = 2): Promise<void> {
  await foundRestTestChat(rig)
  const open = rig.host.collaboratorsForTests().sessions.get(SESSION)!
  const running = open.child!
  rig.adapter.acquire.mock.calls
    .at(-1)?.[0]
    .events?.appendItem(
      { provider: 'codex', threadId: REST_TEST_THREAD, turnId: 'working', ordinal: 50 },
      { kind: 'turn', turnId: 'working', state: 'running' }
    )
  await rig.host.flushStreamedEvents(SESSION)
  const append = vi.spyOn(open.journal, 'appendLifecycleBatch')
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
  it('is settled in place by the retry recording the exit queues, with no reopen', async () => {
    await exitWithUnwrittenSettlement(1)

    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(true)
    expect(await workingTurnState()).toBe('interrupted')
    const { items } = await rig.host.journalSnapshot(SESSION)
    expect(JSON.stringify(items)).toContain(
      'Codex stopped while this response was in progress. You can continue in this conversation.'
    )
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })

  it('is settled when the idle-closed conversation is opened again, and its reader sees it', async () => {
    await exitWithUnwrittenSettlement()
    expect(await workingTurnState()).toBe('running')
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)

    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })

    expect(await workingTurnState()).toBe('interrupted')
    // The death evidence is Orca's log text: the row says only that the provider stopped.
    expect(JSON.stringify(reader.events)).toContain(
      'Codex stopped while this response was in progress. You can continue in this conversation.'
    )
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })

  it('is settled by a read after a restart that reaches the chat before the restore does', async () => {
    await exitWithUnwrittenSettlement()
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)

    // The client's read opens the chat first; the restore then finds it open and skips it.
    expect(await workingTurnState()).toBe('interrupted')
    await rig.host.restoreReadableSessions([SESSION])
    expect(await workingTurnState()).toBe('interrupted')
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })
})
