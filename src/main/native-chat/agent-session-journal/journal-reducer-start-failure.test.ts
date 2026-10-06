// A `pending` dispatch row that records a start refused before it ran keeps its queued message
// waiting, and the reducer counts the attempts from those rows; nothing else stores the count.

import { describe, expect, it } from 'vitest'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionFailedStartIds } from '../../../shared/structured-agent-session-latest-request'
import { isRequeueableAgentJournalSubmission } from '../../../shared/structured-agent-session-dispatch-rejection'
import { nextDeliverableSubmission } from '../agent-session-wire/structured-agent-session-start-attempt-failure'

const EPOCH = 'epoch-1'

function base(seq: number): { v: number; epoch: string; seq: number; fence: number; ts: number } {
  return { v: 1, epoch: EPOCH, seq, fence: 1, ts: 1_000 + seq }
}

function fold(rows: JournalRow[]): JournalReducerState {
  const state = createJournalReducerState('session-1', EPOCH)
  for (const row of rows) {
    applyJournalRow(state, row)
  }
  return state
}

const accepted: JournalRow = {
  kind: 'submission',
  clientMessageId: 'cm_1',
  payloadFingerprint: 'fp_1',
  providerHandle: { kind: 'codex', threadId: 'thread-1' },
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
  handoverRecorded: true,
  ...base(1)
}

/** A row as it is read back from disk, so a newer or a damaged writer's shape reaches the fold. */
function fromDisk(row: Record<string, unknown>): JournalRow {
  const parsed = parseJournalRow(JSON.stringify(row))
  if (!parsed.ok) {
    throw new Error('the row did not parse')
  }
  return parsed.row
}

function failedStart(seq: number, startRetry: unknown): JournalRow {
  return fromDisk({
    kind: 'dispatch',
    clientMessageId: 'cm_1',
    state: 'pending',
    providerItemId: null,
    reason: null,
    startRetry,
    ...base(seq)
  })
}

const RECORD = {
  reason: 'A Claude account switch is in progress.',
  rejection: { kind: 'accountSwitchInProgress' },
  nextAttemptAt: 20_000
}

describe('a failed start recorded on its message', () => {
  it('keeps a queued message in the queue and counts each start refused for it', () => {
    const state = fold([
      accepted,
      failedStart(2, RECORD),
      failedStart(3, { ...RECORD, nextAttemptAt: 80_000 })
    ])

    const submission = state.submissions.get('cm_1')!
    expect(isQueuedAgentJournalSubmission(submission)).toBe(true)
    expect(submission.startRetry).toEqual({
      attempts: 2,
      reason: RECORD.reason,
      rejection: { kind: 'accountSwitchInProgress' },
      failedAt: 1_003,
      nextAttemptAt: 80_000
    })
  })

  // A record a development build wrote names the child whose start failed; nothing reads it.
  it('drops the child an earlier development build named on the record', () => {
    const submission = fold([
      accepted,
      failedStart(2, { ...RECORD, generation: 'generation-2' })
    ]).submissions.get('cm_1')!
    expect(submission.startRetry).not.toHaveProperty('generation')
  })

  it('clears the record when the message is handed over again, or ends', () => {
    const handedOver = fold([
      accepted,
      failedStart(2, RECORD),
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'pending',
        providerItemId: null,
        reason: null,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        ...base(3)
      }
    ]).submissions.get('cm_1')!
    expect(handedOver.startRetry).toBeUndefined()
    expect(handedOver.handedOverAt).toBe(1_003)

    const rejected = fold([
      accepted,
      failedStart(2, RECORD),
      {
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'rejected',
        providerItemId: null,
        reason: RECORD.reason,
        rejection: { kind: 'startFailed' },
        ...base(3)
      }
    ]).submissions.get('cm_1')!
    expect(rejected).toMatchObject({ dispatchState: 'rejected', reason: RECORD.reason })
    expect(rejected.startRetry).toBeUndefined()
  })

  // A child that never proved its start took nothing it was handed, so no reader may read the
  // message as possibly written, as one rejected after its handover otherwise reads.
  it('reads a message its failed start rejected after its handover as never handed over', () => {
    const handedThenRejected = (rejection: { kind: string }) =>
      fold([
        accepted,
        {
          kind: 'dispatch',
          clientMessageId: 'cm_1',
          state: 'pending',
          providerItemId: null,
          reason: null,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE,
          ...base(2)
        },
        fromDisk({
          kind: 'dispatch',
          clientMessageId: 'cm_1',
          state: 'rejected',
          providerItemId: null,
          reason: 'Written by the host.',
          rejection,
          ...base(3)
        })
      ]).submissions.get('cm_1')!

    expect(handedThenRejected({ kind: 'providerStartFailed' }).handedOverAt).toBeUndefined()
    expect(handedThenRejected({ kind: 'hostStopped' }).handedOverAt).toBeUndefined()
    // The provider refusing what it was handed is no failed start: it was handed over.
    expect(handedThenRejected({ kind: 'providerRejected' }).handedOverAt).toBe(1_002)
  })

  // Drawn below the conversation while it waited, a message whose start failed for good stays where
  // its failure was written instead of jumping back above what came since.
  describe('where a message whose start failed for good is placed', () => {
    const later: JournalRow = {
      kind: 'item',
      itemId: 'codex:later-answer',
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'later' }] },
      ...base(3)
    }
    const failed = (kind: string, seq: number): JournalRow =>
      fromDisk({
        kind: 'dispatch',
        clientMessageId: 'cm_1',
        state: 'rejected',
        providerItemId: null,
        reason: 'Written by the host.',
        rejection: { kind },
        ...base(seq)
      })
    const order = (rows: JournalRow[]) =>
      renderJournalState(fold(rows)).items.map((entry) => entry.itemId)
    const message = agentJournalSubmissionKey('cm_1')

    it('stays below what came while it waited', () => {
      expect(
        order([accepted, failedStart(2, RECORD), later, failed('accountSwitchInProgress', 4)])
      ).toEqual(['codex:later-answer', message])
    })

    it('is where it was when nothing came after it', () => {
      expect(order([accepted, failed('providerStartFailed', 2)])).toEqual([message])
    })

    // Not a failed start's rule alone: every rejected message joins the chat where it was rejected.
    it('is placed at its rejection for a rejection that is not a failed start too', () => {
      expect(order([accepted, later, failed('cancelled', 4)])).toEqual([
        'codex:later-answer',
        message
      ])
    })
  })

  it('reads a malformed record as a plain handover: in doubt at the next open, never failed', () => {
    const submission = fold([
      accepted,
      failedStart(2, { reason: 'no fact', nextAttemptAt: 'soon' })
    ]).submissions.get('cm_1')!

    expect(submission.startRetry).toBeUndefined()
    expect(submission.handedOverAt).toBe(1_002)
    expect(isQueuedAgentJournalSubmission(submission)).toBe(false)
  })

  it('ignores the start key a development build of an earlier design wrote on a rejection', () => {
    const rejected = fromDisk({
      kind: 'dispatch',
      clientMessageId: 'cm_1',
      state: 'rejected',
      providerItemId: null,
      reason: RECORD.reason,
      rejection: { kind: 'startFailed' },
      rejectedByStartKey: 'generation-2',
      ...base(2)
    })

    const submission = fold([accepted, rejected]).submissions.get('cm_1')!

    expect(submission).toMatchObject({ dispatchState: 'rejected', reason: RECORD.reason })
    expect(submission).not.toHaveProperty('rejectedByStartKey')
  })
})

// The delivery loop rejects a waiting message with Orca's own fault when it throws mid-delivery. It
// is a failure before any handover like a failed start: every reader treats the two alike.
describe('a waiting message rejected before any handover', () => {
  const later: JournalRow = {
    kind: 'item',
    itemId: 'codex:later-answer',
    revision: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'later' }] },
    ...base(3)
  }
  const rejectedWith = (kind: string): JournalRow =>
    fromDisk({
      kind: 'dispatch',
      clientMessageId: 'cm_1',
      state: 'rejected',
      providerItemId: null,
      reason: 'Written by the host.',
      rejection: { kind },
      ...base(4)
    })
  const message = agentJournalSubmissionKey('cm_1')

  it.each(['accountSwitchInProgress', 'hostFault'])(
    'for %s: stays below what came while it waited, is announced, and can be queued again',
    (kind) => {
      const view = renderJournalState(
        fold([accepted, failedStart(2, RECORD), later, rejectedWith(kind)])
      )
      const submission = view.submissions.find((entry) => entry.clientMessageId === 'cm_1')

      expect(view.items.map((entry) => entry.itemId)).toEqual(['codex:later-answer', message])
      expect(structuredAgentSessionFailedStartIds(view.submissions)).toEqual([message])
      expect(submission && isRequeueableAgentJournalSubmission(submission)).toBe(true)
    }
  )
})

// A Retry sends the message now: ahead of what was queued before the Retry, and drawn there, in the
// order the queue sends.
describe('a message queued again by its Retry', () => {
  const sent = (clientMessageId: string, seq: number): JournalRow => ({
    ...accepted,
    clientMessageId,
    payloadFingerprint: `fp_${clientMessageId}`,
    ...base(seq)
  })
  const dispatch = (clientMessageId: string, seq: number, fields: Record<string, unknown>) =>
    fromDisk({
      kind: 'dispatch',
      clientMessageId,
      providerItemId: null,
      reason: null,
      ...fields,
      ...base(seq)
    })

  const failed = (clientMessageId: string, seq: number) =>
    dispatch(clientMessageId, seq, {
      state: 'rejected',
      reason: 'Codex could not start.',
      rejection: { kind: 'providerStartFailed' }
    })
  const next = (rows: JournalRow[]) =>
    nextDeliverableSubmission({ submissions: () => renderJournalState(fold(rows)).submissions }, 0)

  it('goes ahead of a message queued before the Retry, and is drawn ahead of it', () => {
    const rows = [
      sent('cm_1', 1),
      failed('cm_1', 2),
      sent('cm_2', 3),
      dispatch('cm_1', 4, { state: 'pending', requeued: true })
    ]

    expect(renderJournalState(fold(rows)).items.map((entry) => entry.itemId)).toEqual([
      agentJournalSubmissionKey('cm_1'),
      agentJournalSubmissionKey('cm_2')
    ])
    expect(next(rows)).toMatchObject({ clientMessageId: 'cm_1' })
  })

  it('goes in the order its Retry was pressed among others queued again', () => {
    expect(
      next([
        sent('cm_1', 1),
        failed('cm_1', 2),
        sent('cm_3', 3),
        failed('cm_3', 4),
        sent('cm_2', 5),
        dispatch('cm_3', 6, { state: 'pending', requeued: true }),
        dispatch('cm_1', 7, { state: 'pending', requeued: true })
      ])
    ).toMatchObject({ clientMessageId: 'cm_3' })
  })
})
