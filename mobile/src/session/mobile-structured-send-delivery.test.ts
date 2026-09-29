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
  it('reports every unknown as unconfirmed, host-recorded or ack-lost', () => {
    expect(mobileStructuredSendDelivery({ status: 'unknown' })).toEqual({
      outcome: 'unknown',
      error: null
    })
    expect(mobileStructuredSendDelivery(accepted('unknown'))).toEqual({
      outcome: 'unknown',
      error: null
    })
  })

  it('reports a written send as sent', () => {
    // `pending` is written and awaiting the provider's acknowledgement — not doubt.
    for (const dispatchState of ['accepted', 'pending'] as const) {
      expect(mobileStructuredSendDelivery(accepted(dispatchState))).toEqual({
        outcome: 'accepted',
        error: null
      })
    }
  })

  it('classifies a queued draft answer as accepted, replays included', () => {
    for (const state of ['waiting', 'dispatched', 'returned', 'withdrawn'] as const) {
      const queued: StructuredAgentSessionMutationCallResult<AgentSessionSendResult> = {
        status: 'accepted',
        value: {
          clientMessageId: 'client-1',
          queued: { messageId: 'client-1', position: 1, state }
        }
      }
      expect(mobileStructuredSendDelivery(queued)).toEqual({ outcome: 'accepted', error: null })
    }
  })

  it('withholds the internal reason of a rejection', () => {
    // The marker names nothing a person can act on, so it must not reach the screen.
    expect(
      mobileStructuredSendDelivery(accepted('rejected', 'provider_write_failed: broken pipe'))
    ).toEqual({
      outcome: 'rejected',
      error: "Orca couldn't reach the agent. Your message was not sent. Send it again."
    })
  })

  it('shows a provider content rejection verbatim', () => {
    expect(
      mobileStructuredSendDelivery(accepted('rejected', 'Claude does not support .bmp'))
    ).toEqual({
      outcome: 'rejected',
      error: 'Claude does not support .bmp'
    })
  })

  it('reports only an unknown-outcome refusal as unconfirmed', () => {
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_operation_invalid',
        message: 'Invalid operation'
      })
    ).toEqual({ outcome: 'rejected', error: 'Invalid operation' })
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_checkpoint_stale',
        message: 'Fence moved'
      })
    ).toEqual({ outcome: 'rejected', error: 'Fence moved' })
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_operation_unknown',
        message: 'Outcome unknown'
      })
    ).toEqual({ outcome: 'unknown', error: null })
    expect(
      mobileStructuredSendDelivery({
        status: 'failed',
        message: 'Your message was not sent. Send it again.'
      })
    ).toEqual({
      outcome: 'rejected',
      error: 'Your message was not sent. Send it again.'
    })
  })

  it('fails closed when an invalid host response omits the required submission', () => {
    const result = {
      status: 'accepted',
      value: { clientMessageId: 'msg-1' }
    } as unknown as StructuredAgentSessionMutationCallResult<AgentSessionSendResult>
    expect(mobileStructuredSendDelivery(result)).toEqual({
      outcome: 'unknown',
      error: null
    })
  })
})
