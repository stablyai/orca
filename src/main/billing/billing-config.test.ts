import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

import { getBillingEndpoints } from './billing-config'
import {
  billingCheckoutArgsFromUnknown,
  billingOverageArgsFromUnknown
} from '../ipc/profiles/orca-profile-billing-handlers'

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
  it('accepts Team checkout with an interval and 1..500 seats', () => {
    expect(billingCheckoutArgsFromUnknown({ plan: 'team', interval: 'year', seats: 5 })).toEqual({
      plan: 'team',
      interval: 'year',
      seats: 5
    })
    for (const bad of [
      { plan: 'pro', interval: 'month', seats: 1 },
      { plan: 'team', interval: 'week', seats: 1 },
      { plan: 'team', interval: 'month', seats: 0 },
      { plan: 'team', interval: 'month', seats: 501 },
      { plan: 'team', interval: 'month', seats: 1, extra: true },
      null
    ]) {
      expect(() => billingCheckoutArgsFromUnknown(bad)).toThrow('invalid_orca_billing_checkout')
    }
  })

  it('accepts overage toggles with an optional whole-cent cap', () => {
    expect(billingOverageArgsFromUnknown({ enabled: false })).toEqual({ enabled: false })
    expect(billingOverageArgsFromUnknown({ enabled: true, spendCapCents: 5000 })).toEqual({
      enabled: true,
      spendCapCents: 5000
    })
    for (const bad of [
      { enabled: 'yes' },
      { enabled: true, spendCapCents: -1 },
      { enabled: true, spendCapCents: 1.5 }
    ]) {
      expect(() => billingOverageArgsFromUnknown(bad)).toThrow('invalid_orca_billing_overage')
    }
  })
})
