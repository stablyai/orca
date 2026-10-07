import { describe, expect, it } from 'vitest'
import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import type { StructuredAgentSessionMutationCallResult } from './mobile-structured-agent-session-rpc'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'

const WITHDRAWN_SENTENCE = 'This message was withdrawn before the agent started it.'

function accepted(
  dispatchState: AgentJournalDispatchState,
  reason: string | null = null
): StructuredAgentSessionMutationCallResult<AgentSessionSendResult> {
  return { status: 'accepted', value: structuredSendResultFixture(dispatchState, reason) }
}

describe('mobileStructuredSendDelivery', () => {
  it('keeps the operation id for every unknown, host-recorded or ack-lost', () => {
    // The one answer that may be a delivery. Spending the id here turns the next
    // identical send into a second copy in front of the model.
    expect(mobileStructuredSendDelivery({ status: 'unknown' })).toEqual({
      outcome: 'unknown',
      operationIdSpent: false,
      error: null
    })
    expect(mobileStructuredSendDelivery(accepted('unknown'))).toEqual({
      outcome: 'unknown',
      operationIdSpent: false,
      error: null
    })
  })

  it('reports a written send as sent and spends its id', () => {
    // `pending` is written and awaiting the provider's acknowledgement — not doubt.
    for (const dispatchState of ['accepted', 'pending'] as const) {
      expect(mobileStructuredSendDelivery(accepted(dispatchState))).toEqual({
        outcome: 'accepted',
        operationIdSpent: true,
        error: null
      })
    }
  })

  it('classifies a queued draft answer as spent, card-rendered, never a bubble', () => {
    // The host holds the message now; a later identical send is a new message.
    // A dispatched draft answers as `queued` only when the host lost its
    // submission, so no echo would retire a bubble: it too shows nothing.
    for (const state of ['waiting', 'dispatched', 'returned', 'withdrawn'] as const) {
      const queued: StructuredAgentSessionMutationCallResult<AgentSessionSendResult> = {
        status: 'accepted',
        value: {
          clientMessageId: 'client-1',
          queued: { messageId: 'client-1', position: 1, state }
        }
      }
      const outcome = 'queued'
      expect(mobileStructuredSendDelivery(queued)).toEqual({
        outcome,
        operationIdSpent: true,
        error: null
      })
      expect(mobileStructuredSendDelivery(queued, true)).toEqual({
        outcome,
        operationIdSpent: true,
        error: null
      })
    }
  })

  it("reads a replay answered by its draft's hand-off as unconfirmed, and spends the id", () => {
    // The hand-off names the replayed id as its draft: the host's answer states the link, so the
    // id is spent without waiting for a stream that may never carry the hand-off.
    const handedOff = structuredSendResultFixture('accepted')
    if (!('submission' in handedOff)) {
      throw new Error('expected a submission answer')
    }
    const replay: StructuredAgentSessionMutationCallResult<AgentSessionSendResult> = {
      status: 'accepted',
      value: {
        clientMessageId: 'retained-draft-id',
        submission: {
          ...handedOff.submission,
          clientMessageId: 'fresh-id',
          queuedMessageId: 'retained-draft-id'
        }
      }
    }
    expect(mobileStructuredSendDelivery(replay, true)).toEqual({
      outcome: 'unknown',
      operationIdSpent: true,
      error: null
    })
  })

  it('never spends a retained id on a malformed answer with no submission and no id', () => {
    const malformed: StructuredAgentSessionMutationCallResult<AgentSessionSendResult> = {
      status: 'accepted',
      value: JSON.parse('{}')
    }
    expect(mobileStructuredSendDelivery(malformed, true)).toEqual({
      outcome: 'unknown',
      operationIdSpent: false,
      error: null
    })
  })

  it('does not report a retained payload replay as a new accepted send', () => {
    for (const dispatchState of ['accepted', 'pending'] as const) {
      expect(mobileStructuredSendDelivery(accepted(dispatchState), true)).toEqual({
        outcome: 'unknown',
        operationIdSpent: false,
        error: null
      })
    }
  })

  it('spends the id of a rejection and withholds its internal reason', () => {
    // Provably undelivered and terminal, so the id can only replay it: spending the
    // id makes the retry a first delivery. The marker itself names nothing a person
    // can act on, so it must not reach the screen.
    expect(
      mobileStructuredSendDelivery(accepted('rejected', 'provider_write_failed: broken pipe'))
    ).toEqual({
      outcome: 'rejected',
      operationIdSpent: true,
      error: "Orca couldn't reach the agent. Your message was not sent. Send it again."
    })
  })

  it('answers a send the host kept as a card like a queued one, first send or replay', () => {
    // The card shows the text, so neither an error nor a composer hand-back may repeat it.
    const kept: StructuredAgentSessionMutationCallResult<AgentSessionSendResult> = {
      status: 'accepted',
      value: {
        clientMessageId: 'msg-1',
        submission: {
          clientMessageId: 'msg-1',
          fence: 3,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: 'Orca restarted before this was sent.',
          submittedAt: 10,
          resolvedAt: 10,
          keptAsQueuedMessageId: 'msg-1'
        }
      }
    }
    for (const retained of [false, true]) {
      expect(mobileStructuredSendDelivery(kept, retained)).toEqual({
        outcome: 'queued',
        operationIdSpent: true,
        error: null
      })
    }
  })

  // The chat draws a send a Stop took back with its stop row, so it never goes back to the draft. A
  // retained replay is resent by the caller, which needs the id spent and no words of its own.
  it.each([
    { retained: false, reason: DISPATCH_REJECTED_CANCELLED, fact: false, outcome: 'accepted' },
    { retained: false, reason: WITHDRAWN_SENTENCE, fact: true, outcome: 'accepted' },
    { retained: true, reason: DISPATCH_REJECTED_CANCELLED, fact: false, outcome: 'rejected' },
    { retained: true, reason: WITHDRAWN_SENTENCE, fact: true, outcome: 'rejected' }
  ] as const)(
    'reads a send a Stop took back (retained $retained, typed fact $fact) as $outcome, spent, wordless',
    ({ retained, reason, fact, outcome }) => {
      const value = structuredSendResultFixture('rejected', reason)
      if (fact && 'submission' in value) {
        value.submission.rejection = { kind: 'cancelled' }
      }
      expect(mobileStructuredSendDelivery({ status: 'accepted', value }, retained)).toEqual({
        outcome,
        operationIdSpent: true,
        error: null
      })
    }
  )

  it('shows a provider content rejection verbatim', () => {
    expect(
      mobileStructuredSendDelivery(accepted('rejected', 'Claude does not support .bmp'))
    ).toEqual({
      outcome: 'rejected',
      operationIdSpent: true,
      error: 'Claude does not support .bmp'
    })
  })

  it('spends only refusals that prove the operation is settled', () => {
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_operation_invalid',
        message: 'Invalid operation'
      })
    ).toEqual({ outcome: 'rejected', operationIdSpent: true, error: 'Invalid operation' })
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_checkpoint_stale',
        message: 'Fence moved'
      })
    ).toEqual({ outcome: 'rejected', operationIdSpent: false, error: 'Fence moved' })
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_operation_unknown',
        message: 'Outcome unknown'
      })
    ).toEqual({ outcome: 'unknown', operationIdSpent: false, error: null })
    expect(
      mobileStructuredSendDelivery({
        status: 'failed',
        message: 'Your message was not sent. Send it again.'
      })
    ).toEqual({
      outcome: 'rejected',
      operationIdSpent: true,
      error: 'Your message was not sent. Send it again.'
    })
  })

  it('spends an ambiguous id the host has expired, and says to check the chat', () => {
    // The host refuses an expired id on every replay; keeping it would refuse this text forever.
    // The earlier attempt may still be in the chat, so the words never say it was not sent.
    expect(
      mobileStructuredSendDelivery(
        {
          status: 'refused',
          code: 'agent_session_operation_expired',
          message: 'Operation expired'
        },
        true
      )
    ).toEqual({
      outcome: 'rejected',
      operationIdSpent: true,
      error:
        "Orca couldn't confirm your message reached the agent. Check the chat, then send it again if needed."
    })
  })

  it('never releases an ambiguous id on any other later RPC refusal or failure', () => {
    expect(
      mobileStructuredSendDelivery(
        {
          status: 'refused',
          code: 'agent_session_operation_conflict',
          message: 'Operation conflict'
        },
        true
      )
    ).toEqual({ outcome: 'rejected', operationIdSpent: false, error: 'Operation conflict' })
    expect(
      mobileStructuredSendDelivery(
        { status: 'failed', message: 'Your message was not sent. Send it again.' },
        true
      )
    ).toEqual({
      outcome: 'rejected',
      operationIdSpent: false,
      error: 'Your message was not sent. Send it again.'
    })
  })

  it('releases a replay only when the host refuses its request shape itself', () => {
    // An older host's strict schema refuses `delivery` before it runs anything:
    // that replay can never be accepted, so keeping the id refuses the text forever.
    expect(
      mobileStructuredSendDelivery(
        {
          status: 'failed',
          message: 'Your message was not sent. Send it again.',
          hostRejectedByRequestSchema: true
        },
        true
      )
    ).toEqual({
      outcome: 'rejected',
      operationIdSpent: true,
      error: 'Your message was not sent. Send it again.'
    })
    // Any other refusal (an auth failure, a host without the method) proves nothing
    // about an earlier delivery of this id.
    expect(
      mobileStructuredSendDelivery(
        { status: 'failed', message: 'Your message was not sent.' },
        true
      )
    ).toMatchObject({ operationIdSpent: false })
  })

  it('fails closed when an invalid host response omits the required submission', () => {
    const result = {
      status: 'accepted',
      value: { clientMessageId: 'msg-1' }
    } as unknown as StructuredAgentSessionMutationCallResult<AgentSessionSendResult>
    expect(mobileStructuredSendDelivery(result)).toEqual({
      outcome: 'unknown',
      operationIdSpent: false,
      error: null
    })
  })
})
