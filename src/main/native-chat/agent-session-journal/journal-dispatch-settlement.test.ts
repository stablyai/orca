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

function settle(kind: SubmissionRejectionKind) {
  return rejectedDraftSettlement(
    agentSessionFailureWords(agentSessionFailureFact(kind), { surface: 'rejection' })
  )
}

describe('what a rejection does to the draft it was consumed from', () => {
  it("a Stop's withdrawal sends it back to waiting, under the queue's pause rather than a hold of its own", () => {
    expect(settle('cancelled')).toEqual({ state: 'waiting' })
    expect(rejectedDraftSettlement({ reason: DISPATCH_REJECTED_CANCELLED })).toEqual({
      state: 'waiting'
    })
  })

  it('a restart or close before hand-over sends it back to waiting too', () => {
    for (const kind of ['hostRestarted', 'chatClosed', 'notDelivered'] as const) {
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
