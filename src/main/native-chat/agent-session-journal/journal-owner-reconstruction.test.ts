import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { startJournalRowFold } from './journal-open'
import { serializeJournalRow, type JournalRow } from './journal-row-schema'

const openerIdentity = { provider: 'orca' as const, clientMessageId: 'report' }
const openerId = agentJournalSubmissionKey('report')
const turnIdentity = { provider: 'claude' as const, sessionId: 'thread', uuid: 'turn-B' }
const turnId = agentJournalItemKey(turnIdentity)
const options = { fence: 0, turnScope: { kind: 'thread' as const } }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pr37743-owner-reconstruction-'))
  const journals = createTrackedJournalOpener()
  const input = {
    identity: {
      sessionId: 'owner-reconstruction',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  }
  let journal = await journals.open(input)
  await journal.appendSubmission({
    clientMessageId: 'report',
    payloadFingerprint: 'report',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'report' }] },
    fence: 0,
    handoverRecorded: true
  })
  await journal.resolveDispatch({ clientMessageId: 'report', state: 'pending', ...options })
  return {
    get journal() {
      return journal
    },
    restart: async () => {
      await journals.closeAll()
      journal = await journals.open(input)
    },
    dispose: async () => {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  }
}

it('a first Stop still cancels its running turn after only the opener was removed', async () => {
  const f = await fixture()
  try {
    await f.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'B', state: 'running', userItemId: openerId },
      options
    )
    await f.journal.appendTombstone(openerIdentity, { fence: 0 })
    expect(f.journal.item(openerId)).toBeNull()
    await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
    expect(f.journal.stopMarks.personStopDecides('B')).toBe(true)
    await f.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'B', state: 'interrupted', userItemId: openerId },
      options
    )
    expect(f.journal.itemBody(turnId)).toMatchObject({ outcome: 'cancellation' })
    await f.restart()
    expect(f.journal.stopMarks.cancellations()).toEqual([])
    expect(f.journal.stopMarks.userStopRequestedForItem(turnId)).toBe(true)
  } finally {
    await f.dispose()
  }
})

it('reopening preserves accepted Stop ownership when the terminal revision omits its opener', async () => {
  const f = await fixture()
  try {
    await f.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'B', state: 'running', userItemId: openerId },
      options
    )
    await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
    await f.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'B', state: 'completed', outcome: 'failure' },
      options
    )
    expect(f.journal.stopMarks.userStopRequestedForItem(turnId)).toBe(true)
    await f.restart()
    expect(f.journal.itemBody(turnId)).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(f.journal.stopMarks.userStopRequestedForItem(turnId)).toBe(true)
    await f.journal.resolveDispatch({
      clientMessageId: 'report',
      state: 'unknown',
      recovered: true,
      fence: 0
    })
    await f.journal.appendStopEvent({ reason: 'user-stop' }, 0)
    expect(f.journal.stopMarks.cancellations()).toEqual([])
    await f.restart()
    expect(f.journal.stopMarks.cancellations()).toEqual([])
    expect(f.journal.stopMarks.userStopRequestedForItem(turnId)).toBe(true)
  } finally {
    await f.dispose()
  }
})

it('standalone founding-item replay restores an interrupted pre-ID owner without the prior journal', async () => {
  const f = await fixture()
  try {
    await f.journal.appendStopEvent({ reason: 'user-close' }, 0)
    const expected = f.journal.stopMarks.cancellations().map((entry) => ({ ...entry }))
    expect(expected).toHaveLength(1)
    const opener = f.journal.item(openerId)!
    await f.journal.replaceEpochItems('handle_forked', 0, [
      { identity: openerIdentity, body: opener.body, turnScope: opener.turnScope, ownerFence: 0 }
    ])
    const state = f.journal.queuedMessages.inputState()
    const owner = state.items.get(openerId)!
    expect(owner.executionInterruption).toBeDefined()
    const rows: JournalRow[] = [
      {
        v: 4,
        epoch: state.epoch,
        seq: 1,
        fence: 0,
        ts: owner.observedAt,
        kind: 'epoch',
        reason: 'handle_forked',
        providerHandle: { kind: 'claude', sessionId: 'thread', leafUuid: null }
      },
      {
        v: 4,
        epoch: state.epoch,
        seq: 2,
        fence: 0,
        ts: owner.observedAt,
        kind: 'item',
        itemId: openerId,
        revision: owner.revision,
        body: owner.body,
        turnScope: owner.turnScope,
        ...f.journal.itemProvenance(openerId),
        executionInterruption: owner.executionInterruption
      }
    ]
    const fold = startJournalRowFold({ sessionId: state.sessionId, epoch: state.epoch })
    for (const row of rows) {
      expect(fold.add({ seq: row.seq, rowJson: serializeJournalRow(row) })).toBe(true)
    }
    const replay = fold.finish()
    expect({ newer: replay.newer, damage: replay.damage }).toEqual({ newer: null, damage: null })
    expect(replay.state.submissions.size).toBe(0)
    expect(replay.state.derivedTurnScope.cancellations.pending()).toEqual(expected)
    expect(replay.state.derivedTurnScope.cancellations.unresolved()).toEqual([
      { clientMessageId: 'report', ownerFence: 0 }
    ])
  } finally {
    await f.dispose()
  }
})

it('reusing the provider turn under a new execution owner cannot inherit the old Stop', async () => {
  const f = await fixture()
  try {
    await f.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'B', state: 'running', userItemId: openerId },
      options
    )
    await f.journal.appendStopEvent({ reason: 'user-stop', turnId: 'B' }, 0)
    expect(f.journal.stopMarks.personStopDecides('B')).toBe(true)
    const replacement = { ...options, fence: 1, executionOwner: 1 }
    await f.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'B', state: 'running' },
      replacement
    )
    expect(f.journal.stopMarks.cancellations()).toEqual([])
    expect(f.journal.stopMarks.personStopDecides('B')).toBe(false)
    expect(f.journal.stopMarks.userStopRequestedForItem(turnId)).toBe(false)
    await f.journal.appendItem(
      turnIdentity,
      { kind: 'turn', turnId: 'B', state: 'interrupted' },
      replacement
    )
    expect(f.journal.itemBody(turnId)).not.toHaveProperty('outcome', 'cancellation')
    await f.restart()
    expect(f.journal.stopMarks.cancellations()).toEqual([])
    expect(f.journal.stopMarks.userStopRequestedForItem(turnId)).toBe(false)
  } finally {
    await f.dispose()
  }
})
