import { beforeEach, describe, expect, it } from 'vitest'
import { OrcaCloudRequestError } from '../orca-profiles/cloud-auth/profile-cloud-client'
import {
  BillingServiceError,
  assertStripeHostedUrl,
  claimTrial,
  createCheckoutUrl,
  createPortalUrl,
  BillingOrgMismatchError,
  fetchEntitlement,
  resetBillingExplicitOrgForTests,
  fetchTeamPlans,
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

/** An unsigned JWT-shaped token with these claims (the desktop only decodes the org claim). */
function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.sig`
}

describe('billing client', () => {
  it('mints a billing token with the Orca access token and refuses redirects', async () => {
    const seen: Seen[] = []
    const bt = jwt({ sub: 'u1' })
    const token = await mintBillingToken(
      endpoints,
      'access-1',
      null,
      fakeFetch(
        {
          [endpoints.billingTokenEndpoint]: Response.json({
            billingToken: bt,
            expiresAt: 1
          })
        },
        seen
      )
    )
    expect(token).toBe(bt)
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer access-1')
    expect(seen[0]?.init?.redirect).toBe('error')
  })

  describe('EP-9: the token is for the team this device shows', () => {
    beforeEach(() => resetBillingExplicitOrgForTests())

    it('asks auth for this device\'s team explicitly and accepts a token for it', async () => {
      const seen: Seen[] = []
      const bt = jwt({ sub: 'u1', org: 'org_paid' })
      const fetchImpl = fakeFetch({ [endpoints.billingTokenEndpoint]: Response.json({ billingToken: bt, expiresAt: 1 }) }, seen)
      expect(await mintBillingToken(endpoints, 'a', 'org_paid', fetchImpl)).toBe(bt)
      expect(seen[0]?.init?.body).toBe(JSON.stringify({ orgId: 'org_paid' }))
    })

    it('refuses a token auth minted for another team (another device switched the shared active team)', async () => {
      const fetchImpl: typeof fetch = async () =>
        Response.json({ billingToken: jwt({ sub: 'u1', org: 'org_eval' }), expiresAt: 1 })
      await expect(mintBillingToken(endpoints, 'a', 'org_paid', fetchImpl)).rejects.toBeInstanceOf(BillingOrgMismatchError)
      // A personal account never accepts a team token either.
      await expect(mintBillingToken(endpoints, 'a', null, fetchImpl)).rejects.toBeInstanceOf(BillingOrgMismatchError)
    })

    it('treats 403 not_a_member as a team-switch error, not a session failure', async () => {
      const fetchImpl: typeof fetch = async () =>
        new Response(JSON.stringify({ error: 'not_a_member' }), { status: 403 })
      await expect(mintBillingToken(endpoints, 'a', 'org_gone', fetchImpl)).rejects.toBeInstanceOf(BillingOrgMismatchError)
    })

    it('falls back to the empty body on an older auth (400), still checking the claim', async () => {
      const bodies: (string | undefined)[] = []
      const fetchImpl: typeof fetch = async (_input, init) => {
        bodies.push(typeof init?.body === 'string' ? init.body : undefined)
        return init?.body === '{}'
          ? Response.json({ billingToken: jwt({ sub: 'u1', org: 'org_paid' }), expiresAt: 1 })
          : new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 })
      }
      await mintBillingToken(endpoints, 'a', 'org_paid', fetchImpl)
      expect(bodies).toEqual([JSON.stringify({ orgId: 'org_paid' }), '{}'])
      // Remembered for a while: the next mint skips the body.
      await mintBillingToken(endpoints, 'a', 'org_paid', fetchImpl)
      expect(bodies.at(-1)).toBe('{}')
    })
  })

  it('surfaces an auth rejection as an Orca session failure so the session refreshes', async () => {
    const call = mintBillingToken(
      endpoints,
      'stale',
      null,
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
        monthlyPriceLabel: '$50 per seat per month',
        annualPriceLabel: '$480 per seat, billed yearly',
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
    // A portal cancel's end date (cancel_at) comes through; older services omit it.
    expect(
      (await fetchEntitlement(endpoints, 'bt', response({ cancelAtPeriodEnd: true, cancelAt: 1797167516000 })))
        .cancelAt
    ).toBe(1797167516000)
    expect((await fetchEntitlement(endpoints, 'bt', response({}))).cancelAt).toBeNull()
    // A plan this desktop doesn't know (a newer service) is still a plan, never "no plan".
    expect(
      (await fetchEntitlement(endpoints, 'bt', response({ plan: 'pro', offers: undefined }))).plan
    ).toBe('pro')
    // Billing's running caps when sent; older services omit them, malformed ones are dropped.
    expect(
      (
        await fetchEntitlement(
          endpoints,
          'bt',
          response({
            limits: {
              maxConcurrentSandboxes: 1,
              maxConcurrentSandboxesPerMember: 1,
              machineSizes: ['standard']
            }
          })
        )
      ).limits
    ).toEqual({ maxConcurrentSandboxes: 1, maxConcurrentSandboxesPerMember: 1 })
    expect(entitlement.limits).toBeNull()
    expect(
      (
        await fetchEntitlement(
          endpoints,
          'bt',
          response({ limits: { maxConcurrentSandboxes: 'x' } })
        )
      ).limits
    ).toBeNull()
  })

  it('reads the trial and the trial offer, and claims the trial with a POST', async () => {
    const trial = {
      includedSeconds: 7200,
      usedSeconds: 2160,
      remainingSeconds: 5040,
      exhausted: false,
      grantedAt: 5
    }
    const body = {
      plan: null,
      status: 'trial',
      trial,
      includedSeconds: 7200,
      usedSeconds: 2160,
      remainingIncludedSeconds: 5040,
      canStartSandbox: false,
      reason: 'trial_used_up',
      canManageBilling: true
    }
    const seen: Seen[] = []
    const entitlement = await claimTrial(
      endpoints,
      'bt',
      fakeFetch({ 'https://billing.example.test/v1/billing/trial': Response.json(body) }, seen)
    )
    expect(seen[0]?.init?.method).toBe('POST')
    expect(entitlement).toMatchObject({ status: 'trial', trial, reason: 'trial_used_up' })
    // Older services: no trial fields at all.
    const older = await fetchEntitlement(
      endpoints,
      'bt',
      fakeFetch({
        'https://billing.example.test/v1/billing/entitlements': Response.json({
          ...body,
          trial: undefined,
          reason: 'trial_unavailable'
        })
      })
    )
    expect(older.trial).toBeNull()
    expect(older.reason).toBe('trial_unavailable')
    await expect(
      claimTrial(
        endpoints,
        'bt',
        fakeFetch({
          'https://billing.example.test/v1/billing/trial': Response.json(
            { error: 'trial_unavailable' },
            { status: 403 }
          )
        })
      )
    ).rejects.toMatchObject({ statusCode: 403, errorCode: 'trial_unavailable' })
  })
})

describe('fetchTeamPlans', () => {
  it('posts the team ids with the caller’s own token and returns validated rows', async () => {
    const seen: Seen[] = []
    const team = {
      orgId: 'org_a',
      plan: 'team',
      planLabel: 'Team',
      canStartSandbox: true
    }
    const teams = await fetchTeamPlans(
      endpoints,
      'bt',
      ['org_a', 'org_b'],
      fakeFetch(
        {
          'https://billing.example.test/v1/billing/team-plans': Response.json({ teams: [team] })
        },
        seen
      )
    )
    expect(teams).toEqual([team])
    expect(seen[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ orgIds: ['org_a', 'org_b'] })
    expect(new Headers(seen[0]?.init?.headers).get('authorization')).toBe('Bearer bt')
  })

  it('rejects a malformed answer', async () => {
    await expect(
      fetchTeamPlans(
        endpoints,
        'bt',
        ['org_a'],
        fakeFetch({
          'https://billing.example.test/v1/billing/team-plans': Response.json({
            teams: [{ orgId: 'org_a', canStartSandbox: 'yes' }]
          })
        })
      )
    ).rejects.toThrow('invalid_billing_response')
  })
})
