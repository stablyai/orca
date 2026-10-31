import { openTestChats } from './structured-agent-session-open-test-chats.test-support'
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

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

/** Refuse exit settlement and its retry so only conversation reopen can settle the old work. */
async function exitWithUnwrittenSettlement(
  refusedWrites = 2,
  evidence?: 'kill-delivered'
): Promise<void> {
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
    ...(evidence ? { deathEvidenceKind: evidence } : {}),
    cause: 'unexpected-exit',
    fence: running.fence,
    acquisitionGeneration: running.generation!
  })
  await vi.waitFor(() =>
    expect(rig.store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: evidence ?? 'exit-observed' }
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

  it('shows a killed generation as interrupted on the first subscription after idle reopen', async () => {
    await exitWithUnwrittenSettlement(2, 'kill-delivered')
    expect(await workingTurnState()).toBe('running')
    rig.clock.now += IDLE_MS + 1
    await sweepOnce(rig.host)
    expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)

    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })

    expect(await workingTurnState()).toBe('interrupted')
    // Internal death diagnostics must not reach transcript readers.
    expect(JSON.stringify(reader.events)).toContain(
      'Codex stopped while this response was in progress. You can continue in this conversation.'
    )
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })

  it('is settled by a read after a restart that reaches the chat before the restore does', async () => {
    await exitWithUnwrittenSettlement()
    await rig.restart()
    setStructuredAgentSessionHost(rig.host)

    expect(await workingTurnState()).toBe('interrupted')
    await openTestChats(rig.host, [SESSION])
    expect(await workingTurnState()).toBe('interrupted')
    expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  })
})
