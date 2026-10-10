import { describe, expect, it } from 'vitest'
import {
  agentSessionFailureFact,
  type SubmissionRejectionKind
} from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_HOST_RESTARTED
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { rejectedDraftSettlement } from './journal-dispatch-settlement'
import {
  journalPendingSubmissionResolutions,
  type JournalPendingSubmission
} from './journal-pending-submission-recovery'

function settle(kind: SubmissionRejectionKind) {
  return rejectedDraftSettlement(
    agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'rejection' })
  )
}

describe('what a rejection does to the draft it was consumed from', () => {
  it('keeps recovered and queued sends out of terminal verdicts and preserves a sharper doubt reason', () => {
    const submissions: JournalPendingSubmission[] = [
      { clientMessageId: 'pending', dispatchState: 'pending' },
      { clientMessageId: 'doubt', dispatchState: 'unknown', reason: 'write outcome unknown' },
      { clientMessageId: 'settled', dispatchState: 'unknown', recovered: true as const },
      { clientMessageId: 'queued', dispatchState: 'pending', handoverRecorded: true as const },
      { clientMessageId: 'accepted', dispatchState: 'accepted' }
    ]
    expect(journalPendingSubmissionResolutions(submissions, 7, { reason: 'owner exited' })).toEqual(
      [
        {
          clientMessageId: 'pending',
          state: 'unknown',
          reason: 'owner exited',
          fence: 7,
          recovered: true
        },
        {
          clientMessageId: 'doubt',
          state: 'unknown',
          reason: 'write outcome unknown',
          fence: 7,
          recovered: true
        }
      ]
    )
    const rejection = agentSessionFailureWords(agentSessionFailureFact('startFailed'), {
      surface: 'rejection'
    })
    expect(journalPendingSubmissionResolutions(submissions, 7, { rejection })).toEqual([
      { clientMessageId: 'pending', state: 'rejected', ...rejection, fence: 7, recovered: true },
      { clientMessageId: 'doubt', state: 'rejected', ...rejection, fence: 7, recovered: true }
    ])
  })

  it("a Stop's withdrawal sends it back to waiting, under the queue's pause rather than a hold of its own", () => {
    expect(settle('cancelled')).toEqual({ state: 'waiting' })
    expect(rejectedDraftSettlement({ reason: DISPATCH_REJECTED_CANCELLED })).toEqual({
      state: 'waiting'
    })
    expect(settle('notDelivered')).toEqual({ state: 'waiting' })
  })

  // Whoever sent it, it waits under the reopen's pause like every card the chat closed with.
  it('a restart or close before hand-over sends it back to waiting, with no hold of its own', () => {
    for (const kind of ['hostRestarted', 'chatClosed'] as const) {
      expect(settle(kind)).toEqual({ state: 'waiting' })
    }
    expect(rejectedDraftSettlement({ reason: DISPATCH_REJECTED_HOST_RESTARTED })).toEqual({
      state: 'waiting'
    })
  })

  it('a failure returns the card for the user to act on', () => {
    for (const kind of [
      'providerRejected',
      'providerExited',
      'hostStopped',
      'startFailed',
      'writeFailed',
      'queueFull'
    ] as const) {
      expect(settle(kind)).toEqual({ state: 'returned' })
    }
    expect(rejectedDraftSettlement({ reason: 'the provider said no' })).toEqual({
      state: 'returned'
    })
  })
})
