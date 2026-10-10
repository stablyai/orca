import { describe, expect, it } from 'vitest'
import type { AgentJournalDispatchState } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
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
  it('keeps the typed auth fact beside guidance until the transcript can explain it', () => {
    const result = structuredSendResultFixture('rejected', 'Sign in to Grok with `grok login`.')
    if (!('submission' in result)) {
      throw new Error('expected submission')
    }
    const fact = {
      kind: 'notSignedIn' as const,
      detail: { text: 'Key expired.', audience: 'person' as const }
    }
    result.submission.rejection = fact
    expect(mobileStructuredSendDelivery({ status: 'accepted', value: result })).toEqual({
      outcome: 'rejected',
      error: 'Sign in to Grok with `grok login`.',
      failure: fact
    })
    result.submission.rejection = { kind: 'providerRejected' }
    expect(mobileStructuredSendDelivery({ status: 'accepted', value: result }).error).toContain(
      'Sign in'
    )
  })
  it('reports transport and host uncertainty on this send', () => {
    expect(mobileStructuredSendDelivery({ status: 'unknown' })).toEqual({
      outcome: 'unknown',
      error: null
    })
    expect(mobileStructuredSendDelivery(accepted('unknown'))).toEqual({
      outcome: 'unknown',
      error: null
    })
  })

  it.each(['accepted', 'pending'] as const)('reports a written %s send as accepted', (state) => {
    expect(mobileStructuredSendDelivery(accepted(state))).toEqual({
      outcome: 'accepted',
      error: null
    })
  })

  it.each(['waiting', 'dispatched', 'returned'] as const)(
    'lets the host own its %s queued message without an optimistic bubble',
    (state) => {
      expect(
        mobileStructuredSendDelivery({
          status: 'accepted',
          value: {
            clientMessageId: 'client-1',
            queued: { messageId: 'client-1', position: 1, state }
          }
        })
      ).toEqual({ outcome: 'queued', error: null })
    }
  )

  it('hands back a withdrawn card instead of silently sending again', () => {
    expect(
      mobileStructuredSendDelivery({
        status: 'accepted',
        value: {
          clientMessageId: 'client-1',
          queued: { messageId: 'client-1', position: 1, state: 'withdrawn' }
        }
      })
    ).toEqual({ outcome: 'rejected', error: 'Message not sent' })
  })

  it('keeps a handed-off queued message unconfirmed until the stream identifies it', () => {
    const value = structuredSendResultFixture('accepted')
    if (!('submission' in value)) {
      throw new Error('expected a submission answer')
    }
    expect(
      mobileStructuredSendDelivery({
        status: 'accepted',
        value: {
          clientMessageId: 'draft-id',
          submission: {
            ...value.submission,
            clientMessageId: 'fresh-id',
            queuedMessageId: 'draft-id'
          }
        }
      })
    ).toEqual({ outcome: 'unknown', error: null })
  })

  it('fails closed when a malformed answer has no submission', () => {
    expect(mobileStructuredSendDelivery({ status: 'accepted', value: JSON.parse('{}') })).toEqual({
      outcome: 'unknown',
      error: null
    })
  })

  it('withholds internal provider write reasons', () => {
    expect(
      mobileStructuredSendDelivery(accepted('rejected', 'provider_write_failed: broken pipe'))
    ).toEqual({
      outcome: 'rejected',
      error: "Orca couldn't reach the agent. Your message was not sent. Send it again."
    })
  })

  it('lets a kept queued card hold the text after a provider rejection', () => {
    const value = structuredSendResultFixture('rejected', 'Orca restarted before this was sent.')
    if (!('submission' in value)) {
      throw new Error('expected a submission answer')
    }
    value.submission.keptAsQueuedMessageId = 'card-id'
    expect(mobileStructuredSendDelivery({ status: 'accepted', value })).toEqual({
      outcome: 'queued',
      error: null
    })
  })

  it.each([
    { reason: DISPATCH_REJECTED_CANCELLED, typed: false },
    { reason: 'This message was withdrawn before the agent started it.', typed: true }
  ])('leaves a stopped submission in its existing chat row (typed $typed)', ({ reason, typed }) => {
    const value = structuredSendResultFixture('rejected', reason)
    if (typed && 'submission' in value) {
      value.submission.rejection = { kind: 'cancelled' }
    }
    expect(mobileStructuredSendDelivery({ status: 'accepted', value })).toEqual({
      outcome: 'accepted',
      error: null
    })
  })

  it('shows an actionable content rejection', () => {
    expect(
      mobileStructuredSendDelivery(accepted('rejected', 'Claude does not support .bmp'))
    ).toEqual({ outcome: 'rejected', error: 'Claude does not support .bmp' })
  })

  it.each([
    ['agent_session_operation_invalid', 'Invalid operation'],
    ['agent_session_checkpoint_stale', 'Fence moved'],
    ['agent_session_operation_expired', 'Operation expired'],
    ['agent_session_operation_conflict', 'Operation conflict']
  ] as const)('reports the current %s refusal', (code, message) => {
    expect(mobileStructuredSendDelivery({ status: 'refused', code, message })).toEqual({
      outcome: 'rejected',
      error: message
    })
  })

  it('preserves an unknown operation refusal as uncertainty', () => {
    expect(
      mobileStructuredSendDelivery({
        status: 'refused',
        code: 'agent_session_operation_unknown',
        message: 'Outcome unknown'
      })
    ).toEqual({ outcome: 'unknown', error: null })
  })

  it('reports a request failure without consulting earlier sends', () => {
    expect(
      mobileStructuredSendDelivery({
        status: 'failed',
        message: 'Your message was not sent. Send it again.'
      })
    ).toEqual({ outcome: 'rejected', error: 'Your message was not sent. Send it again.' })
  })
})
