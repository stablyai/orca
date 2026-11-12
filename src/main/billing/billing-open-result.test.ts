import { describe, expect, it } from 'vitest'
import { BillingServiceError } from './billing-client'
import { openResultForError } from './billing-open-result'

describe('openResultForError', () => {
  it('maps billing refusals to typed results', () => {
    expect(openResultForError(new BillingServiceError(409, 'plan_unavailable'))).toEqual({
      status: 'plan-unavailable'
    })
    expect(openResultForError(new BillingServiceError(409, 'already_subscribed'))).toEqual({
      status: 'already-subscribed'
    })
    expect(openResultForError(new BillingServiceError(409, 'team_required'))).toEqual({
      status: 'team-required'
    })
    expect(openResultForError(new BillingServiceError(403, 'billing_admin_required'))).toEqual({
      status: 'forbidden'
    })
    expect(openResultForError(new Error('timeout'))).toEqual({ status: 'failed', error: 'timeout' })
  })
})
