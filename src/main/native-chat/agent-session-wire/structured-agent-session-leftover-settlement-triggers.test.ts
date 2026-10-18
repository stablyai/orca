// An ended generation's leftovers settle in one commit once storage takes it; meanwhile a send goes
// out, a stale answer is refused plainly, and reading the chat writes nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import {
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts
} from '../../../shared/agent-session-refusal-notice'
import { agentSessionRefusalFailure } from '../../../shared/agent-session-write-failure'
import { journaledSubagent } from '../agent-session-journal/journal-subagent-item'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { structuredQueueHold } from './structured-agent-session-queued-messages'
import {
  APPROVAL,
  currentJournal,
  currentWork,
  exitWhileSettlementFails,
  leaveUnfinishedWork,
  logEveryWrite,
  REASONING,
  reconciled,
  recoveredRows,
  rowFence,
  sendText,
  TASK,
  TOOL,
  turnState,
  watchSettlementCommits
} from './structured-agent-session-leftover-settlement.test-fixture'

import { retryOwes } from './structured-agent-session-retry.test-fixture'

let rig: QueuedMessageTestRig | undefined

function answerApproval(current: QueuedMessageTestRig) {
  const prompt = currentJournal(current).item(agentJournalItemKey(APPROVAL))
  if (!prompt) {
    throw new Error('expected the saved prompt')
  }
  const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'yes' }
  return current.host.respondToPrompt(CALLER, {
    envelope: {
      ...current.envelope(fields, 'agentSession.respondTo:approval', hostTestOperationId()),
      expectedRuntimeFence: current.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    },
    kind: 'approval',
    ...fields
  })
}

afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

describe('an observed exit whose settlement the database refused', () => {
  it('is settled by the retry in one commit, while the next send starts and delivers', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    const firstSend = await current.workingSend()
    await leaveUnfinishedWork(current, { everything: true })
    const { session, database, deadFence } = await exitWhileSettlementFails(current)

    // The fault holds: a queue-if-active send is accepted, starts its agent and is delivered.
    const { clientOperationId, result } = sendText(current, 'continue while storage fails')
    expect(await result).toMatchObject({ ok: true })
    expect(session.journal.queuedMessages.list()).toEqual([])
    expect(session.journal.submission(clientOperationId)).toBeDefined()
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
    expect(session.child?.fence).toBe(deadFence + 2)
    expect(turnState(current)).toBe('running')
    // The dead agent's prompt takes no answer, and says so plainly.
    const refused = await answerApproval(current)
    expect(refused).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'promptOwnerEnded' } }
    })
    if (refused.ok) {
      throw new Error('expected the answer refused')
    }
    expect(
      agentSessionWriteNoticeEnglish(
        agentSessionWriteNoticeParts(agentSessionRefusalFailure(refused.refusal), 'answer', {
          agentName: 'Codex'
        })
      )
    ).toBe('Codex has stopped, so your answer was not sent. Send a message to continue.')
    expect(current.answerPrompt).not.toHaveBeenCalled()

    const commits = watchSettlementCommits()
    database.db.exec('DROP TRIGGER reject_recovered')
    await reconciled(current)

    // One transaction at the successor's fence, judged by the exit's proof.
    expect(commits()).toHaveLength(1)
    const settled = recoveredRows(database.db)
    expect(settled.map(rowFence)).toEqual(settled.map(() => deadFence + 2))
    expect(turnState(current)).toBe('interrupted')
    const body = (identity: AgentJournalItemIdentity) =>
      session.journal.itemBody(agentJournalItemKey(identity))
    expect(body(APPROVAL)).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(body(TOOL)).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
    expect(body(REASONING)).not.toMatchObject({ state: 'running' })
    expect(journaledSubagent(session.journal, 'a')).toMatchObject({ state: 'unverifiable' })
    expect(body(TASK)).toMatchObject({
      blocks: [
        { text: 'Background command "sleep 20" stopped reporting' },
        { state: 'unverifiable' }
      ]
    })
    // Handed over and never answered: doubt, never "not delivered".
    expect(session.journal.submission(firstSend)).toMatchObject({ dispatchState: 'unknown' })
    // The successor's send is its own, untouched.
    expect(session.journal.submission(clientOperationId)?.dispatchState).not.toBe('unknown')
  })
})

describe('reading a chat', () => {
  it('opens a chat whose leftovers are owed with zero writes, by every reader', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    // Answered, so no send left pending keeps the conversation open.
    await current.settleAccepted(await current.workingSend(), 'work')
    await leaveUnfinishedWork(current, { prompt: true })
    // The fault stays, so every retry rolls back: any logged write is a reader's.
    const { database } = await exitWhileSettlementFails(current)
    await current.host.close(SESSION, 'evict')
    expect(current.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
    const writes = logEveryWrite(database.db)

    await current.host.revealSession(SESSION)
    await current.host.history({ sessionId: SESSION, direction: 'tail' })
    await current.host.journalSnapshot(SESSION)
    const unsubscribe = await current.host.subscribe({
      id: 'reader',
      sessionId: SESSION,
      emit: () => undefined
    })
    unsubscribe()

    expect(writes()).toEqual([])
    // Still owed, and still as the dead generation left it: only the host's retry settles it.
    expect(retryOwes(current.host.collaboratorsForTests().reconciliation, SESSION)).toBe(true)
    expect(turnState(current)).toBe('running')
    const work = currentWork(current)
    expect(work.working()).toBe(false)
    expect(structuredQueueHold({ record: current.store.getRecord(SESSION), work })).toBeNull()
  })
})
