import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchNousRateLimits } from './nous-fetcher'
import type { NousAuthSession } from './nous-auth'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

const PORTAL = 'https://portal.nousresearch.com'

function makeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

function makeSession(overrides: Partial<NousAuthSession> = {}): NousAuthSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    clientId: 'hermes-cli',
    portalBaseUrl: PORTAL,
    // Why: 30 minutes out — comfortably inside the 2-minute refresh skew.
    expiresAtMs: Date.now() + 30 * 60 * 1000,
    ...overrides
  }
}

function makeSubscriptionPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    org: { name: 'Acme Inc', id: 'org_acme' },
    context: 'personal',
    current: {
      tierId: 'plus',
      tierName: 'Plus',
      monthlyCredits: '1000',
      creditsRemaining: '580',
      cycleEndsAt: '2026-08-31T23:59:59Z'
    },
    canChangePlan: true,
    ...overrides
  }
}

// Why: top-up credits arrive on /api/oauth/account, not the subscription
// payload — mirror the Hermes CLI /usage credits fields (snake_case).
function makeAccountPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    user: { email: 'user@example.com' },
    organisation: { id: 'org_acme', slug: 'acme', name: 'Acme Inc' },
    subscription: {
      plan: 'Plus',
      tier: 1,
      monthly_credits: '1000',
      current_period_end: '2026-08-31T23:59:59Z',
      credits_remaining: '580',
      rollover_credits: '0'
    },
    paid_service_access: {
      allowed: true,
      paid_access: true,
      has_active_subscription: true,
      subscription_credits_remaining: '580',
      purchased_credits_remaining: '0',
      total_usable_credits: '580'
    },
    ...overrides
  }
}

describe('fetchNousRateLimits', () => {
  // Why: persistNousRefresh writes under HERMES_HOME; point it at a temp dir so
  // the refresh path can never touch the developer's real ~/.hermes/auth.json.
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'nous-fetcher-test-'))
    process.env.HERMES_HOME = hermesHome
    fetchMock.mockReset()
    // Why: the top-up breakdown fetch is best-effort and runs alongside the
    // subscription; default it to an empty account payload so tests that only
    // exercise the subscription lane stay deterministic.
    fetchMock.mockResolvedValue(makeResponse({ paid_service_access: null }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.HERMES_HOME
    rmSync(hermesHome, { recursive: true, force: true })
  })

  it('returns unavailable when no Hermes session exists', async () => {
    const result = await fetchNousRateLimits({ authReadResult: { status: 'missing' } })
    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('nous')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.error).toMatch(/hermes portal/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces an auth-file read error as unavailable', async () => {
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'error', error: 'Hermes auth file is invalid' }
    })
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('Hermes auth file is invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches the subscription and account breakdown with a fresh stored token', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(makeSubscriptionPayload()))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('nous')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${PORTAL}/api/billing/subscription`)
    expect(init.method).toBeUndefined()
    expect(init.headers.Authorization).toBe('Bearer access-token')
    const [accountUrl, accountInit] = fetchMock.mock.calls[1]
    expect(accountUrl).toBe(`${PORTAL}/api/oauth/account`)
    expect(accountInit.headers.Authorization).toBe('Bearer access-token')
  })

  it('maps monthly credits to a window with amounts and the plan tier', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(makeSubscriptionPayload()))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.planType).toBe('Plus')
    // used = 1000 - 580 = 420 → 42%
    expect(result.monthly).toMatchObject({
      usedPercent: 42,
      windowMinutes: 43_200,
      usedAmount: 420,
      remainingAmount: 580,
      resetsAt: Date.parse('2026-08-31T23:59:59Z')
    })
  })

  it('refreshes an expired token before fetching the subscription', async () => {
    const session = makeSession({
      // Why: expired 10 minutes ago → the refresh lane runs.
      expiresAtMs: Date.now() - 10 * 60 * 1000
    })
    fetchMock
      .mockResolvedValueOnce(
        makeResponse({ access_token: 'fresh-token', refresh_token: 'rotated-rt', expires_in: 3599 })
      )
      .mockResolvedValueOnce(makeResponse(makeSubscriptionPayload()))
    const result = await fetchNousRateLimits({ authReadResult: { status: 'ok', session } })
    expect(result.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe(`${PORTAL}/api/oauth/token`)
    expect(tokenInit.method).toBe('POST')
    expect(tokenInit.headers['x-nous-refresh-token']).toBe('refresh-token')
    expect(tokenInit.body.toString()).toContain('grant_type=refresh_token')
    expect(tokenInit.body.toString()).toContain('client_id=hermes-cli')
    const [, subscriptionInit] = fetchMock.mock.calls[1]
    expect(subscriptionInit.headers.Authorization).toBe('Bearer fresh-token')
    const [, accountInit] = fetchMock.mock.calls[2]
    expect(accountInit.headers.Authorization).toBe('Bearer fresh-token')
  })

  it('uses the stored token without refreshing when it is fresh', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(makeSubscriptionPayload()))
    await fetchNousRateLimits({ authReadResult: { status: 'ok', session: makeSession() } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer access-token')
  })

  it('classifies a failed token refresh as stale-token', async () => {
    const session = makeSession({ expiresAtMs: Date.now() - 60_000 })
    fetchMock.mockResolvedValueOnce(makeResponse({ error: 'invalid_grant' }, 401))
    const result = await fetchNousRateLimits({ authReadResult: { status: 'ok', session } })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies subscription 401 as stale-token', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, 401))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.error).toMatch(/hermes portal/i)
  })

  it('classifies subscription 403 as stale-token', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, 403))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('classifies a 500 as server', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse({}, 500))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toMatch(/500/)
  })

  it('classifies malformed JSON as parse', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      }
    } as unknown as Response)
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.error).toContain('Unexpected token')
  })

  it('treats a non-object payload as parse', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse('html'))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('keeps ok with no window for a free-tier (current: null) session', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(makeSubscriptionPayload({ current: null })))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    expect(result.monthly).toBeNull()
    expect(result.planType).toBeNull()
  })

  it('keeps ok with no window when credit amounts are missing', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(makeSubscriptionPayload({ current: { tierId: 'plus', tierName: 'Plus' } }))
    )
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    expect(result.monthly).toBeNull()
  })

  it('clamps and rounds decimal credits', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        makeSubscriptionPayload({
          current: {
            tierId: 'plus',
            tierName: 'Plus',
            monthlyCredits: '142.5',
            creditsRemaining: '0.4'
          }
        })
      )
    )
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    // used = 142.1 → 99.7% → clamp to 100
    expect(result.monthly?.usedPercent).toBe(100)
    expect(result.monthly?.usedAmount).toBe(142.1)
    expect(result.monthly?.remainingAmount).toBe(0.4)
  })

  it('maps the account breakdown into nousCredits (top-up + total usable)', async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(makeSubscriptionPayload())).mockResolvedValueOnce(
      makeResponse(
        makeAccountPayload({
          paid_service_access: {
            allowed: true,
            paid_access: true,
            subscription_credits_remaining: '580',
            purchased_credits_remaining: '42.5',
            total_usable_credits: '622.5'
          }
        })
      )
    )
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    expect(result.nousCredits).toEqual({
      subscriptionRemaining: 580,
      topUpRemaining: 42.5,
      totalUsable: 622.5
    })
  })

  it('keeps the subscription snapshot when the account breakdown is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(makeSubscriptionPayload()))
      .mockResolvedValueOnce(makeResponse({}, 500))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    expect(result.nousCredits).toBeNull()
    expect(result.monthly?.remainingAmount).toBe(580)
    expect(result.planType).toBe('Plus')
  })

  it('omits nousCredits when the account payload has no usable fields', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse(makeSubscriptionPayload()))
      .mockResolvedValueOnce(makeResponse(makeAccountPayload({ paid_service_access: null })))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('ok')
    expect(result.nousCredits).toBeNull()
    expect(result.monthly).not.toBeNull()
  })

  it('classifies network failures as network', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const result = await fetchNousRateLimits({
      authReadResult: { status: 'ok', session: makeSession() }
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toMatch(/ECONNREFUSED/)
  })
})
