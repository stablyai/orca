// A failed wake/restart/unarchive carries the plan's refusal, so the window's card can say why.
import { describe, expect, it } from 'vitest'
import { HostedEntitlementDeniedError, wakeBillingDenial } from './hosted-environment-provider'

describe('wakeBillingDenial', () => {
  it('carries the billing reason of a plan refusal', () => {
    const error = new HostedEntitlementDeniedError('refused', 'subscription_inactive')
    expect(wakeBillingDenial(error)).toEqual({ billingDenial: { reason: 'subscription_inactive' } })
    expect(wakeBillingDenial(new HostedEntitlementDeniedError('refused', null))).toEqual({
      billingDenial: { reason: null }
    })
  })

  it('adds nothing for any other failure', () => {
    expect(wakeBillingDenial(new Error('boom'))).toEqual({})
    expect(wakeBillingDenial('x')).toEqual({})
  })
})
