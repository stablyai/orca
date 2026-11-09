import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { getBillingEndpoints } from './billing-config'
import { billingCheckoutArgsFromUnknown } from '../ipc/profiles/orca-profile-billing-handlers'

const authConfig = { apiBaseUrl: 'https://login.onorca.dev' }

describe('billing config', () => {
  it('is unconfigured until a billing URL is set', () => {
    expect(getBillingEndpoints(authConfig, {}, true)).toBeNull()
  })

  it('derives the token endpoint from Orca Cloud auth', () => {
    expect(
      getBillingEndpoints(authConfig, { ORCA_BILLING_API_URL: 'https://billing.onorca.dev' }, true)
    ).toEqual({
      billingApiUrl: 'https://billing.onorca.dev',
      billingTokenEndpoint: 'https://login.onorca.dev/v1/desktop/auth/billing-token'
    })
  })

  it('allows loopback http only in development builds', () => {
    const env = { ORCA_BILLING_API_URL: 'http://127.0.0.1:8790' }
    expect(getBillingEndpoints(authConfig, env, false)?.billingApiUrl).toBe('http://127.0.0.1:8790')
    expect(getBillingEndpoints(authConfig, env, true)).toBeNull()
  })
})

describe('billing IPC args', () => {
  it('accepts known plans and Team seats only', () => {
    expect(billingCheckoutArgsFromUnknown({ plan: 'pro', seats: 5 })).toEqual({
      plan: 'pro'
    })
    expect(billingCheckoutArgsFromUnknown({ plan: 'team', seats: 5 })).toEqual({
      plan: 'team',
      seats: 5
    })
    expect(() => billingCheckoutArgsFromUnknown({ plan: 'free' })).toThrow(
      'invalid_orca_billing_plan'
    )
    expect(() => billingCheckoutArgsFromUnknown({ plan: 'team', seats: 0 })).toThrow(
      'invalid_orca_billing_seats'
    )
    expect(() => billingCheckoutArgsFromUnknown(null)).toThrow('invalid_orca_billing_plan')
  })
})
