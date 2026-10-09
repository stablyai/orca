// The chat's reconciliation worker: what retires it, what keeps it, and what readers see before it
// has written anything.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { settleStructuredAgentSessionLeftovers } from './structured-agent-session-leftover-settlement'
import {
  currentJournal,
  exitChild,
  exitWhileSettlementFails,
  leaveUnfinishedWork,
  reconciled,
  recoveredRows,
  REJECT_RECOVERED_ROWS,
  turnState,
  watchSettlementCommits
} from './structured-agent-session-leftover-settlement.test-fixture'

let rig: QueuedMessageTestRig | undefined

afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

function worker(current: QueuedMessageTestRig) {
  return current.host.collaboratorsForTests().reconciliation
}

describe('a retry dies', () => {
  it('on supersession: a later settlement covered what it owed, so it writes nothing and retires', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // A crash, and a new process whose storage refuses settlement rows from its first write; its
    // recovery releases the owner it cannot prove gone.
    await current.crashRestartHostProcess(() =>
      openTestJournalHostDatabase(current.root).db.exec(REJECT_RECOVERED_ROWS)
    )
    const database = openTestJournalHostDatabase(current.root)
    expect(worker(current).owes(SESSION)).toBe(true)
    expect(turnState(current)).toBe('running')
    database.db.exec('DROP TRIGGER reject_recovered')

    // Another settlement lands first, as a later generation's end would run it.
    expect(
      await settleStructuredAgentSessionLeftovers({
        store: current.store,
        sessionId: SESSION,
        journal: currentJournal(current)
      })
    ).toMatchObject({ ok: true })
    expect(turnState(current)).toBe('unverifiable')
    const commits = watchSettlementCommits()
    const settled = recoveredRows(database.db)

    await reconciled(current)

    expect(commits()).toEqual([])
    expect(recoveredRows(database.db)).toEqual(settled)
  })

  it('on the chat’s deletion: no record, nothing owed', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    const { database } = await exitWhileSettlementFails(current)
    const getRecord = current.store.getRecord
    vi.spyOn(current.store, 'getRecord').mockImplementation((sessionId) =>
      sessionId === SESSION ? null : getRecord(sessionId)
    )
    database.db.exec('DROP TRIGGER reject_recovered')

    await reconciled(current)

    expect(recoveredRows(database.db)).toEqual([])
  })

  it('at shutdown: its timer stops, and nothing is written after', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    const { database } = await exitWhileSettlementFails(current)
    database.db.exec('DROP TRIGGER reject_recovered')

    current.host.stopDelivery()

    expect(worker(current).owes(SESSION)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(recoveredRows(database.db)).toEqual([])
    expect(turnState(current)).toBe('running')
  })
})

describe('an observed exit whose release write failed', () => {
  it('is Working for no reader at once, restated with no row, and the worker owes the release until it lands', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    const fence = current.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await current.host.subscribe({
      id: 'reader',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const cursor = currentJournal(current).cursor()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const database = openTestJournalHostDatabase(current.root)
    database.db.exec(REJECT_RECOVERED_ROWS)
    const release = vi
      .spyOn(current.store, 'transitionHandoff')
      .mockRejectedValue(new Error('temporary storage failure'))

    await exitChild(current)

    // The lease still names the gone child, and the journal has not moved...
    expect(current.store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: fence,
      claimStatus: 'live'
    })
    expect(currentJournal(current).cursor()).toEqual(cursor)
    expect(turnState(current)).toBe('running')
    // ...yet the host's view already says nothing runs, and the reader was told so.
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        type: 'batch',
        batch: { items: [], cursor },
        working: false,
        latestTurn: null
      })
    )

    // The items settle once storage takes rows again; the release is still owed, and an empty
    // item plan never retires it.
    database.db.exec('DROP TRIGGER reject_recovered')
    await vi.waitFor(() => expect(turnState(current)).toBe('interrupted'), { timeout: 10_000 })
    await worker(current).idle(SESSION)
    expect(worker(current).owes(SESSION)).toBe(true)
    expect(current.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')

    release.mockRestore()
    await reconciled(current)
    expect(current.store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: fence + 1,
      claimStatus: 'released',
      deathEvidence: { kind: 'exit-observed', ownerFence: fence }
    })
    unsubscribe()
  })
})

describe('a journal no retry can load', () => {
  it.each([
    ['damaged', '}{'],
    ['saved by a newer Orca', null]
  ] as const)(
    '%s: the startup worker retires instead of replaying it again',
    async (_why, json) => {
      rig = await createQueuedMessageTestRig({ restartable: true })
      const current = rig
      await current.settleAccepted(await current.workingSend(), 'work')
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let opens = 0
      await current.crashReloadHostProcess(() => {
        const { db } = openTestJournalHostDatabase(current.root)
        const epochRow = liveTestJournalRows(db, SESSION).find((row) => row.seq === 1)!
        const newer = {
          ...JSON.parse(epochRow.rowJson),
          v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1
        }
        updateTestJournalRowJson(db, SESSION, 1, json ?? JSON.stringify(newer))
        const open = AgentSessionJournal.prototype.open
        vi.spyOn(AgentSessionJournal.prototype, 'open').mockImplementation(async function (
          this: AgentSessionJournal
        ) {
          opens += 1
          return open.call(this)
        })
      })

      expect(worker(current).owes(SESSION)).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      expect(opens).toBe(1)
    }
  )
})

describe("the startup share's reopen mark", () => {
  // Bookkeeping, reported and never owed: the pause starts where the handle opened either way.
  it.each([false, true])(
    'never holds the queue past the turn that lifts it (its write fails: %s)',
    async (failMark) => {
      rig = await createQueuedMessageTestRig()
      const current = rig
      await current.workingSend()
      const queued = await current.send('queued before the crash', 'queue-if-active').result
      if (!queued.ok || !('queued' in queued.value)) {
        throw new Error('expected a queued receipt')
      }
      const draftId = queued.value.queued.messageId
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      await current.crashRestartHostProcess(() => {
        if (failMark) {
          vi.spyOn(AgentSessionJournal.prototype, 'appendQueueReopen').mockRejectedValue(
            new Error('persistent storage failure')
          )
        }
      })
      const journal = currentJournal(current)
      // Held from the open, before any mark could land.
      expect(structuredQueuePauses(journal).map((pause) => pause.reason)).toEqual(['restarted'])

      const next = current.send('sent after the restart')
      await next.result
      await current.settleAccepted(next.id, 'next')

      await eventually(async () => expect(await current.handoff(draftId)).toBeDefined())
      await reconciled(current)
    }
  )
})

describe("an ended generation's closing tail", () => {
  it('lands at its own fence after the exit settled, and its worker settles what it left running', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    // A running turn is left, so the exit's settlement writes rows.
    await leaveUnfinishedWork(current)
    const deadFence = current.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await exitChild(current)
    await reconciled(current)
    const tail = (ordinal: number): AgentJournalItemIdentity => ({
      provider: 'codex',
      threadId: THREAD,
      turnId: 'late',
      ordinal
    })
    const late = { fence: deadFence, ownerFence: deadFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }

    // What the closed sink had already taken, delivered after the exit: it lands.
    await currentJournal(current).appendItem(
      tail(1),
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'final answer' }] },
      late
    )
    await currentJournal(current).appendItem(
      tail(2),
      { kind: 'turn', turnId: 'late', state: 'running' },
      late
    )

    expect(currentJournal(current).itemBody(agentJournalItemKey(tail(1)))).not.toBeNull()
    // Below the moved fence, so its commit woke the worker, which settles it by the exit's proof.
    await vi.waitFor(() =>
      expect(
        readAgentJournalTurn(
          currentJournal(current).itemBody(agentJournalItemKey(tail(2))) ?? undefined
        )?.state
      ).toBe('interrupted')
    )
    await reconciled(current)
  })
})
