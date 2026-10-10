// The retry of background bookkeeping, driven by every way a generation ends: what it settles, that
// it settles in one commit, and that nothing a person does ever waits on it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import {
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts
} from '../../../shared/agent-session-refusal-notice'
import { agentSessionRefusalFailure } from '../../../shared/agent-session-write-failure'
import { isSubagentGroupBlock } from '../../../shared/native-chat-types'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { codexSubagentGroupIdentity } from '../../codex/codex-subagent-roster'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { structuredQueueHold } from './structured-agent-session-queued-messages'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import {
  APPROVAL,
  currentJournal,
  currentWork,
  exitChild,
  exitWhileSettlementFails,
  leaveUnfinishedWork,
  REASONING,
  reconciled,
  recoveredRows,
  REJECT_RECOVERED_ROWS,
  rowFence,
  ROSTER_GROUP,
  sendText,
  startUp,
  TASK,
  TOOL,
  turnState,
  watchSettlementCommits
} from './structured-agent-session-leftover-settlement.test-fixture'
import { retryOwes } from './structured-agent-session-retry.test-fixture'

let rig: QueuedMessageTestRig | undefined

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

    // The fault holds: the send is accepted, starts its agent and is delivered all the same.
    const { clientOperationId, result } = sendText(current, 'continue while storage fails')
    expect(await result).toMatchObject({ ok: true })
    expect(session.journal.queuedMessages.list()).toEqual([])
    expect(session.journal.submission(clientOperationId)).toBeDefined()
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
    expect(session.child?.fence).toBe(deadFence + 2)
    expect(turnState(current)).toBe('running')

    const commits = watchSettlementCommits()
    database.db.exec('DROP TRIGGER reject_recovered')
    await reconciled(current)

    // One transaction, at the lease's current fence (the successor's), judged by the exit's proof
    // though the successor's reservation cleared it from the lease.
    expect(commits()).toHaveLength(1)
    const settled = recoveredRows(database.db)
    expect(settled.map(rowFence)).toEqual(settled.map(() => deadFence + 2))
    expect(turnState(current)).toBe('interrupted')
    const body = (identity: AgentJournalItemIdentity) =>
      session.journal.itemBody(agentJournalItemKey(identity))
    expect(body(APPROVAL)).toMatchObject({ resolution: { state: 'cancelled' } })
    expect(body(TOOL)).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
    expect(body(REASONING)).not.toMatchObject({ state: 'running' })
    const roster = body(codexSubagentGroupIdentity(ROSTER_GROUP))
    expect(
      roster?.kind === 'message' ? roster.blocks.find(isSubagentGroupBlock)?.agents : undefined
    ).toMatchObject([{ id: 'a', state: 'unverifiable' }])
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

  it('settles at the exit itself when nothing refuses it, once', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    const database = openTestJournalHostDatabase(current.root)
    const commits = watchSettlementCommits()

    await exitChild(current)
    await reconciled(current)

    expect(turnState(current)).toBe('interrupted')
    expect(commits()).toHaveLength(1)
    const settled = recoveredRows(database.db)
    // The next start finds nothing left: the retry its end signals writes no row.
    expect((await sendText(current, 'next').result).ok).toBe(true)
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
    await reconciled(current)
    expect(recoveredRows(database.db)).toEqual(settled)
  })
})

describe('a settlement that cannot commit never gates the user', () => {
  it('delivers the queue-if-active send the STOP reproduction stranded', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    const { session } = await exitWhileSettlementFails(current)

    const { clientOperationId, result } = sendText(current, 'still stranded?')

    expect(await result).toMatchObject({ ok: true })
    expect((await result).ok && 'queued' in (await result)).toBe(false)
    expect(session.journal.queuedMessages.list()).toEqual([])
    expect(session.journal.submission(clientOperationId)).toBeDefined()
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
  })

  it('reads a dead generation’s open turn as not Working, holds nothing, and delivers', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    await exitWhileSettlementFails(current)
    const journal = currentJournal(current)
    const record = current.store.getRecord(SESSION)
    const fence = record?.lease.runtimeFence ?? 0
    const work = currentWork(current)

    // Still saved as running: only its settlement would end it.
    expect(turnState(current)).toBe('running')
    expect(work.working()).toBe(false)
    expect(structuredQueueHold({ record, work })).toBeNull()
    expect(isMainAgentWorking({ journal, fence, currentWork: () => work })).toBe(false)
    const { items, submissions } = journal.snapshot()
    expect(
      projectStructuredAgentSessionStatusState(items, submissions, fence, work.scope).summary.status
    ).not.toBe('working')

    expect((await sendText(current, 'go on').result).ok).toBe(true)
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
  })

  it('drains a card that waited on the dead generation, with no journal write', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    const queued = await current.send('after this turn', 'queue-if-active').result
    expect(queued).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    expect(currentJournal(current).queuedMessages.list()).toHaveLength(1)
    const database = openTestJournalHostDatabase(current.root)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    database.db.exec(REJECT_RECOVERED_ROWS)
    const child = current.host.collaboratorsForTests().sessions.get(SESSION)?.child
    if (!child?.generation) {
      throw new Error('expected the live child')
    }

    await current.host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      cause: 'unexpected-exit',
      reason: 'observed exit',
      fence: child.fence,
      acquisitionGeneration: child.generation
    })

    // The end alone woke the drain: the card went out though nothing settled the turn.
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
    expect(recoveredRows(database.db)).toEqual([])
    expect(turnState(current)).toBe('running')
  })
})

describe('the retry', () => {
  /** Lets every attempt a fired timer began run to its end, with no fake time passing. */
  async function settleTurns(): Promise<void> {
    for (let turn = 0; turn < 50; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  it('backs off from 1 s, doubling; a new signal adds no round to the backoff; settles once the fault clears', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      rig = await createQueuedMessageTestRig({ restartable: true })
      const current = rig
      await current.workingSend()
      await leaveUnfinishedWork(current, { prompt: true })
      const { database } = await exitWhileSettlementFails(current)
      const reconciliation = current.host.collaboratorsForTests().reconciliation
      const attempts = vi.spyOn(currentJournal(current), 'appendPlannedLifecycleBatch')
      expect(retryOwes(reconciliation, SESSION)).toBe(true)

      await vi.advanceTimersByTimeAsync(990)
      await settleTurns()
      expect(attempts).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10)
      await settleTurns()
      expect(attempts).toHaveBeenCalledTimes(1)
      // The second failure doubled the wait.
      await vi.advanceTimersByTimeAsync(1_990)
      await settleTurns()
      expect(attempts).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10)
      await settleTurns()
      expect(attempts).toHaveBeenCalledTimes(2)

      // A new signal while it backs off adds no round: the timer's next step runs it.
      reconciliation.signal(SESSION)
      await settleTurns()
      expect(attempts).toHaveBeenCalledTimes(2)
      expect(turnState(current)).toBe('running')
      database.db.exec('DROP TRIGGER reject_recovered')
      await vi.advanceTimersByTimeAsync(1_990)
      await settleTurns()
      expect(attempts).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10)
      await settleTurns()
      expect(retryOwes(reconciliation, SESSION)).toBe(false)
      expect(turnState(current)).toBe('interrupted')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a stale prompt', () => {
  it('holds no send, refuses a stale answer in plain words, and ends cancelled once settled', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    const { session, database } = await exitWhileSettlementFails(current)
    const prompt = session.journal.item(agentJournalItemKey(APPROVAL))
    if (!prompt) {
      throw new Error('expected the saved prompt')
    }
    const answer = () => {
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

    // Unsettled, it holds nothing and takes no answer: the agent that asked is gone.
    expect((await sendText(current, 'go on without it').result).ok).toBe(true)
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
    expect(session.journal.itemBody(prompt.itemId)).toMatchObject({
      resolution: { state: 'pending' }
    })
    const refused = await answer()
    expect(refused).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'promptOwnerEnded' } }
    })
    if (refused.ok) {
      throw new Error('expected the answer refused')
    }
    // One sentence: the agent stopped, the answer was not sent, and how to go on.
    const words = agentSessionWriteNoticeEnglish(
      agentSessionWriteNoticeParts(agentSessionRefusalFailure(refused.refusal), 'answer', {
        agentName: 'Codex'
      })
    )
    expect(words).toBe(
      'Codex has stopped, so your answer was not sent. Send a message to continue.'
    )
    expect(current.answerPrompt).not.toHaveBeenCalled()

    database.db.exec('DROP TRIGGER reject_recovered')
    await reconciled(current)

    expect(session.journal.itemBody(prompt.itemId)).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    expect((await answer()).ok).toBe(false)
    expect(current.answerPrompt).not.toHaveBeenCalled()
  })
})

describe('a late write from an ended generation', () => {
  it('is settled by the retry its commit wakes', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    // Answered, so the exit leaves nothing to settle and writes no row at the moved fence.
    await current.settleAccepted(await current.workingSend(), 'work')
    const deadFence = current.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
    await exitChild(current)
    await reconciled(current)
    const database = openTestJournalHostDatabase(current.root)
    expect(recoveredRows(database.db)).toEqual([])
    const lateCall: AgentJournalItemIdentity = {
      provider: 'codex',
      threadId: THREAD,
      turnId: 'late',
      ordinal: 1
    }

    // An operation the closed sink had already taken lands at the generation's own fence.
    await currentJournal(current).appendItem(
      lateCall,
      { kind: 'tool-call', name: 'shell', input: { command: 'make' }, state: 'running' },
      { fence: deadFence, ownerFence: deadFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    await vi.waitFor(() =>
      expect(currentJournal(current).itemBody(agentJournalItemKey(lateCall))).toMatchObject({
        state: 'failed'
      })
    )
    await reconciled(current)
    expect(recoveredRows(database.db).map(rowFence)).toEqual([deadFence + 1])
  })
})

describe('startup', () => {
  it('settles a failed exit settlement with no stored mark, starting nothing', async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current, { prompt: true })
    const { deadFence } = await exitWhileSettlementFails(current)
    // A new process loads the database and the record store back from disk, and starts up.
    await current.crashReloadHostProcess()
    await reconciled(current)
    const database = openTestJournalHostDatabase(current.root)
    // The retry opened the chat itself, so it closes it again: nothing else had it open.
    await vi.waitFor(() =>
      expect(current.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
    )
    await current.host.journalSnapshot(SESSION)

    expect(turnState(current)).toBe('interrupted')
    expect(currentJournal(current).itemBody(agentJournalItemKey(APPROVAL))).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    const settled = recoveredRows(database.db)
    expect(settled.map(rowFence)).toEqual(settled.map(() => deadFence + 1))
    expect(current.starts).toHaveBeenCalledOnce()
    // A second pass finds nothing owed.
    await startUp(current)
    expect(recoveredRows(database.db)).toEqual(settled)
  })
})

describe('a folder workspace', () => {
  it('settles a folder chat’s dead generation the same way, and delivers', async () => {
    rig = await createQueuedMessageTestRig({
      restartable: true,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder-1',
        workspaceKind: 'folder'
      }
    })
    const current = rig
    await current.workingSend()
    await leaveUnfinishedWork(current)
    const { session, database } = await exitWhileSettlementFails(current)

    const { clientOperationId, result } = sendText(current, 'continue in the folder')

    expect(await result).toMatchObject({ ok: true })
    expect(session.journal.submission(clientOperationId)).toBeDefined()
    await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalledTimes(2))
    database.db.exec('DROP TRIGGER reject_recovered')
    await reconciled(current)
    expect(turnState(current)).toBe('interrupted')
  })
})
