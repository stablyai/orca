import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { restoreJournal } from './journal-open'

for (const rebuild of ['retained-opener', 'removed-opener'] as const) {
  it(`keeps pre-ID close and later Stop as separate execution history through epoch replacement with ${rebuild} and restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pr37743-request-history-'))
    const journals = createTrackedJournalOpener()
    const input = {
      identity: {
        sessionId: 'history',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'claude' as const,
        providerHandle: claudeProviderHandle('thread', null)
      },
      stateDirectory: root,
      now: () => 1000
    }
    let journal = await journals.open(input)
    const openerId = agentJournalSubmissionKey('report')
    const turnIdentity = { provider: 'claude' as const, sessionId: 'thread', uuid: 'history-turn' }
    try {
      await journal.appendSubmission({
        clientMessageId: 'report',
        payloadFingerprint: 'report',
        fence: 0,
        handoverRecorded: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'report' }] }
      })
      await journal.resolveDispatch({
        clientMessageId: 'report',
        state: 'pending',
        fence: 0,
        turnScope: { kind: 'thread' }
      })
      await journal.appendStopEvent({ reason: 'user-close' }, 0)
      await journal.appendStopEvent({ reason: 'user-stop' }, 0)
      await journal.appendItem(
        turnIdentity,
        { kind: 'turn', turnId: 'history-turn', state: 'running', userItemId: openerId },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      await journal.appendItem(
        turnIdentity,
        {
          kind: 'turn',
          turnId: 'history-turn',
          state: 'completed',
          outcome: 'failure',
          completedAt: 999,
          userItemId: openerId
        },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      expect(journal.stopMarks.cancellations()).toEqual([])
      const history = () => {
        const state = journal.queuedMessages.inputState()
        return state.derivedTurnScope.cancellations.history(state, 'history-turn')
      }
      const original = history()
      expect(original).toMatchObject({
        first: { event: { reason: 'user-close' } },
        userStop: { event: { reason: 'user-stop' } }
      })
      await journal.replaceEpochItems(
        'handle_forked',
        0,
        journal
          .snapshot()
          .items.filter((item) => rebuild === 'retained-opener' || item.body.kind === 'turn')
          .map((item) => ({
            identity:
              item.body.kind === 'turn'
                ? { ...turnIdentity, uuid: 'remapped-history-turn' }
                : { provider: 'orca' as const, clientMessageId: 'report' },
            body: item.body,
            turnScope: item.turnScope,
            ownerFence: 0
          }))
      )
      await journals.closeAll()
      journal = await journals.open(input)
      expect(history()).toEqual(original)
      expect(journal.stopMarks.cancellations()).toEqual([])
      await journal.appendQueueResume(0)
      expect(history()).toEqual(original)
      const loaded = restoreJournal(openTestJournalHostDatabase(root).db, 'history')!
      expect(
        loaded.state.derivedTurnScope.cancellations.history(loaded.state, 'history-turn')
      ).toEqual(original)
      expect(journal.snapshot().items.find((i) => i.body.kind === 'turn')?.body).toMatchObject({
        outcome: 'failure'
      })
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })
}

it('late unknown dispatch cannot resurrect the opener of an authoritative terminal turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr37743-close2-opener-'))
  const journals = createTrackedJournalOpener()
  const input = {
    identity: {
      sessionId: 'close2-opener',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  }
  let journal = await journals.open(input)
  const pending = () => journal.stopMarks.cancellations()
  const identity = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
  const body = {
    kind: 'turn' as const,
    turnId: 'B',
    userItemId: agentJournalSubmissionKey('report-B')
  }
  try {
    await journal.appendSubmission({
      clientMessageId: 'report-B',
      payloadFingerprint: 'B',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'report B' }] },
      fence: 0,
      handoverRecorded: true
    })
    await journal.resolveDispatch({
      clientMessageId: 'report-B',
      state: 'pending',
      fence: 0,
      turnScope: { kind: 'thread' }
    })
    await journal.appendItem(
      identity,
      { ...body, state: 'running' },
      { fence: 0, turnScope: { kind: 'thread' } }
    )
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
    expect(pending()).toHaveLength(1)
    await journal.appendItem(
      identity,
      { ...body, state: 'interrupted' },
      { fence: 0, turnScope: { kind: 'thread' } }
    )
    expect(pending()).toEqual([])
    // Production pending-send recovery can settle a still-pending acknowledgement after its turn.
    await journal.resolveDispatch({
      clientMessageId: 'report-B',
      state: 'unknown',
      fence: 0,
      recovered: true
    })
    // No execution remains. A later queue Stop must not create interruption debt for finished B.
    await journal.appendStopEvent({ reason: 'user-stop' }, 0)
    const before = pending().map((x) => ({ ...x }))
    await journals.closeAll()
    journal = await journals.open(input)
    expect(before).toEqual([])
    expect(pending()).toEqual([])
    await journal.appendItem(
      identity,
      { ...body, state: 'running' },
      { fence: 0, turnScope: { kind: 'thread' } }
    )
    expect(journal.stopMarks.cancellations()).toEqual([])
    expect(journal.itemBody(agentJournalSubmissionKey('report-B'))).toBeDefined()
    expect(journal.snapshot().items.every((item) => !('executionInterruption' in item))).toBe(true)
    expect(journal.item(agentJournalSubmissionKey('report-B'))).not.toHaveProperty(
      'executionInterruption'
    )
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
