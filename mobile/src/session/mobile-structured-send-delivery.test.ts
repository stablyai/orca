import { describe, expect, it } from 'vitest'
import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import type { StructuredAgentSessionMutationCallResult } from './mobile-structured-agent-session-rpc'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'

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

  it('never releases an ambiguous id on a later RPC refusal or failure', () => {
    expect(
      mobileStructuredSendDelivery(
        {
          status: 'refused',
          code: 'agent_session_operation_expired',
          message: 'Operation expired'
        },
        true
      )
    ).toEqual({ outcome: 'rejected', operationIdSpent: false, error: 'Operation expired' })
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
