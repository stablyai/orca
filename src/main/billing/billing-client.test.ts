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
      { plan: 'team', interval: 'month', seats: 1 },
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

  it('sends plan, interval and seats and returns the hosted Checkout URL', async () => {
    const seen: Seen[] = []
    const url = await createCheckoutUrl(
      endpoints,
      'bt',
      { plan: 'team', interval: 'year', seats: 3 },
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
      interval: 'year',
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

  it('normalizes the entitlement and drops unknown or unsafe fields', async () => {
    const offers = {
      team: {
        label: 'Team',
        monthlyPriceLabel: '$50/seat/mo',
        annualPriceLabel: '$480/seat/yr',
        includedHoursPerSeat: 60,
        concurrentSandboxesPerSeat: 3,
        idleSleepMinutes: 15,
        overageCentsPerHour: 75,
        defaultSpendCapCents: 2500
      },
      enterprise: {
        label: 'Enterprise',
        priceLabel: 'Custom',
        contactUrl: 'https://onorca.dev/sales'
      }
    }
    const response = (extra: Record<string, unknown>) =>
      fakeFetch({
        'https://billing.example.test/v1/billing/entitlements': Response.json({
          plan: 'team',
          planLabel: 'Team',
          status: 'active',
          interval: 'year',
          seats: 2,
          period: { start: 1, end: 2 },
          usageWindow: { start: 1, end: 2 },
          includedSeconds: 432000,
          usedSeconds: 36000,
          remainingIncludedSeconds: 396000,
          usageWarningPercent: null,
          overageSeconds: 0,
          overage: {
            optedIn: true,
            active: true,
            spendCapCents: 2500,
            spentCents: 75,
            centsPerHour: 75
          },
          canStartSandbox: true,
          reason: 'something_new',
          canManageBilling: true,
          accountId: 'org:o1',
          offers,
          ...extra
        })
      })
    const entitlement = await fetchEntitlement(endpoints, 'bt', response({}))
    expect(entitlement).toMatchObject({
      plan: 'team',
      interval: 'year',
      usedSeconds: 36000,
      reason: null,
      canManageBilling: true,
      overage: { optedIn: true, spentCents: 75 },
      offers
    })
    expect(entitlement).not.toHaveProperty('accountId')
    // A non-https contact link is never handed to the renderer.
    const unsafe = await fetchEntitlement(
      endpoints,
      'bt',
      response({
        offers: {
          ...offers,
          enterprise: { ...offers.enterprise, contactUrl: 'javascript:alert(1)' }
        }
      })
    )
    expect(unsafe.offers).toBeNull()
    expect(
      (await fetchEntitlement(endpoints, 'bt', response({ plan: 'pro', offers: undefined }))).plan
    ).toBeNull()
  })
})
