import { describe, expect, it } from 'vitest'
import { OrcaCloudRequestError } from '../orca-profiles/profile-cloud-client'
import {
  BillingServiceError,
  assertStripeHostedUrl,
  createCheckoutUrl,
  createPortalUrl,
  fetchEntitlement,
  mintBillingToken
} from './billing-client'

const endpoints = {
  billingApiUrl: 'https://billing.example.test',
  billingTokenEndpoint: 'https://login.example.test/v1/desktop/auth/billing-token'
}

type Seen = { url: string; init: RequestInit | undefined }

function fakeFetch(responses: Record<string, Response>, seen: Seen[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input)
    seen.push({ url, init })
    const response = responses[url]
    if (!response) {
      throw new Error(`unexpected ${url}`)
    }
    return response
  }
}

describe('billing client', () => {
  it('mints a billing token with the Orca access token and refuses redirects', async () => {
    const seen: Seen[] = []
    const token = await mintBillingToken(
      endpoints,
      'access-1',
      fakeFetch(
        {
          [endpoints.billingTokenEndpoint]: Response.json({
            billingToken: 'bt',
            expiresAt: 1
          })
        },
        seen
      )
    )
    expect(token).toBe('bt')
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer access-1')
    expect(seen[0]?.init?.redirect).toBe('error')
  })

  it('surfaces an auth rejection as an Orca session failure so the session refreshes', async () => {
    const call = mintBillingToken(
      endpoints,
      'stale',
      fakeFetch({
        [endpoints.billingTokenEndpoint]: new Response(null, { status: 401 })
      })
    )
    await expect(call).rejects.toBeInstanceOf(OrcaCloudRequestError)
  })

  it('reports billing refusals as BillingServiceError, never as a session failure', async () => {
    const call = createCheckoutUrl(
      endpoints,
      'bt',
      { plan: 'pro' },
      fakeFetch({
        'https://billing.example.test/v1/billing/checkout': Response.json(
          { error: 'already_subscribed' },
          { status: 409 }
        )
      })
    )
    await expect(call).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'already_subscribed'
    })
    await expect(call).rejects.toBeInstanceOf(BillingServiceError)
  })

  it('sends seats only for Team and returns the hosted Checkout URL', async () => {
    const seen: Seen[] = []
    const url = await createCheckoutUrl(
      endpoints,
      'bt',
      { plan: 'team', seats: 3 },
      fakeFetch(
        {
          'https://billing.example.test/v1/billing/checkout': Response.json({
            url: 'https://checkout.stripe.com/c/pay/cs_test_1'
          })
        },
        seen
      )
    )
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_test_1')
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
      plan: 'team',
      seats: 3
    })
  })

  it('only opens Stripe-hosted pages', async () => {
    expect(assertStripeHostedUrl('https://billing.stripe.com/p/session/x')).toBe(
      'https://billing.stripe.com/p/session/x'
    )
    for (const bad of [
      'http://checkout.stripe.com/x',
      'https://checkout.stripe.com.evil.test/x',
      'https://evil.test/x',
      'https://user@billing.stripe.com/x',
      'javascript:alert(1)',
      42
    ]) {
      expect(() => assertStripeHostedUrl(bad)).toThrow()
    }
    const portal = createPortalUrl(
      endpoints,
      'bt',
      fakeFetch({
        'https://billing.example.test/v1/billing/portal': Response.json({
          url: 'https://evil.test/'
        })
      })
    )
    await expect(portal).rejects.toThrow('invalid_billing_url')
  })

  it('normalizes the entitlement and drops unknown fields', async () => {
    const entitlement = await fetchEntitlement(
      endpoints,
      'bt',
      fakeFetch({
        'https://billing.example.test/v1/billing/entitlements': Response.json({
          plan: 'pro',
          planLabel: 'Pro',
          status: 'active',
          seats: 1,
          period: { start: 1, end: 2 },
          includedSeconds: 180000,
          usedSeconds: 36000,
          remainingIncludedSeconds: 144000,
          overageSeconds: 0,
          overageEnabled: true,
          overageCapSeconds: 360000,
          canStartSandbox: true,
          reason: 'something_new',
          canManageBilling: true,
          accountId: 'org:o1',
          plans: [
            { plan: 'pro', label: 'Pro', priceLabel: '$25/mo', includedHours: 50, perSeat: false },
            {
              plan: 'enterprise',
              label: 'Enterprise',
              priceLabel: 'Talk to us',
              includedHours: 0,
              perSeat: true
            }
          ]
        })
      })
    )
    expect(entitlement).toMatchObject({
      plan: 'pro',
      usedSeconds: 36000,
      reason: null,
      canManageBilling: true
    })
    expect(entitlement).not.toHaveProperty('accountId')
    expect(entitlement.plans).toEqual([
      { plan: 'pro', label: 'Pro', priceLabel: '$25/mo', includedHours: 50, perSeat: false }
    ])
  })
})
