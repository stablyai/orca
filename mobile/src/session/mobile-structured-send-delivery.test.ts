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
      error: "Couldn't reach the agent. Your message was not sent — Retry to send it again."
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
    ).toEqual({ outcome: 'rejected', operationIdSpent: true, error: 'Fence moved' })
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_operation_unknown',
        message: 'Outcome unknown'
      })
    ).toEqual({ outcome: 'unknown', operationIdSpent: false, error: null })
    expect(mobileStructuredSendDelivery({ status: 'failed', message: 'Request not sent' })).toEqual(
      {
        outcome: 'rejected',
        operationIdSpent: true,
        error: 'Message not sent'
      }
    )
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
      mobileStructuredSendDelivery({ status: 'failed', message: 'Request not sent' }, true)
    ).toEqual({ outcome: 'rejected', operationIdSpent: false, error: 'Message not sent' })
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
