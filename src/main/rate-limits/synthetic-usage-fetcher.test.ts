import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const netFetch = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: netFetch }, session: { defaultSession: {} } }))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn().mockResolvedValue(undefined)
}))
import { fetchSyntheticRateLimits, SYNTHETIC_QUOTAS_URL } from './synthetic-usage-fetcher'

const subscription = { requests: 27, limit: 135, renewsAt: '2026-10-01T14:36:14.288Z' }
beforeEach(() => {
  netFetch.mockReset()
  vi.stubEnv('SYNTHETIC_API_KEY', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('Synthetic quotas', () => {
  it('prefers rolling usage and reports weekly refills, not full resets', async () => {
    netFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          subscription,
          rollingFiveHourLimit: { max: 750, remaining: 747.8, nextTickAt: '2026-10-01T14:40:00Z' },
          weeklyTokenLimit: { percentRemaining: 62.12, nextRegenAt: '2026-10-01T17:00:00Z' }
        })
      )
    )
    const result = await fetchSyntheticRateLimits('placeholder')
    expect(result.requestQuota).toEqual({ requests: 2.2, limit: 750, renewsAt: null })
    expect(result.session).toMatchObject({
      resetsAt: null,
      refillsAt: Date.parse('2026-10-01T14:40:00Z')
    })
    expect(result.weekly?.usedPercent).toBeCloseTo(37.88)
    expect(result.weekly).toMatchObject({
      resetsAt: null,
      refillsAt: Date.parse('2026-10-01T17:00:00Z')
    })
  })

  it.each([
    { tickPercent: 0.05, nextRegenCredits: '$5.00', requestTicks: 4, weeklyTicks: 8 },
    { tickPercent: 0.1, nextRegenCredits: '$10.00', requestTicks: 2, weeklyTicks: 4 }
  ])(
    'calculates full recharge from API refill amounts: %j',
    async ({ tickPercent, nextRegenCredits, requestTicks, weeklyTicks }) => {
      netFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            subscription,
            rollingFiveHourLimit: {
              max: 750,
              remaining: 600,
              nextTickAt: '2026-10-01T14:40:00Z',
              tickPercent
            },
            weeklyTokenLimit: {
              percentRemaining: 60,
              nextRegenAt: '2026-10-01T17:00:00Z',
              maxCredits: '$100.00',
              nextRegenCredits
            }
          })
        )
      )
      const result = await fetchSyntheticRateLimits('placeholder')
      expect(result.session?.rechargesAt).toBe(
        Date.parse('2026-10-01T14:40:00Z') + (requestTicks - 1) * 15 * 60_000
      )
      expect(result.weekly?.rechargesAt).toBe(
        Date.parse('2026-10-01T17:00:00Z') + (weeklyTicks - 1) * 202 * 60_000
      )
    }
  )

  it.each([undefined, 0, 'invalid'])(
    'keeps usage without guessing an invalid refill amount: %s',
    async (amount) => {
      netFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            subscription,
            rollingFiveHourLimit: {
              max: 750,
              remaining: 600,
              nextTickAt: '2026-10-01T14:40:00Z',
              tickPercent: amount
            },
            weeklyTokenLimit: {
              percentRemaining: 60,
              nextRegenAt: '2026-10-01T17:00:00Z',
              maxCredits: '$100.00',
              nextRegenCredits: amount
            }
          })
        )
      )
      const result = await fetchSyntheticRateLimits('placeholder')
      expect(result.status).toBe('ok')
      expect(result.session?.rechargesAt).toBeNull()
      expect(result.weekly?.rechargesAt).toBeNull()
      expect(result.session?.refillsAt).toBe(Date.parse('2026-10-01T14:40:00Z'))
    }
  )

  it('shows no countdown on full rolling or weekly allowances', async () => {
    netFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          subscription,
          rollingFiveHourLimit: { max: 750, remaining: 750, nextTickAt: '2026-10-01T14:40:00Z' },
          weeklyTokenLimit: { percentRemaining: 100, nextRegenAt: '2026-10-01T17:00:00Z' }
        })
      )
    )
    const result = await fetchSyntheticRateLimits('placeholder')
    expect(result.session).toMatchObject({ usedPercent: 0, resetsAt: null, refillsAt: null })
    expect(result.weekly).toMatchObject({ usedPercent: 0, resetsAt: null, refillsAt: null })
  })

  it.each([
    { requests: 0, expected: 0 },
    { requests: 1, expected: 100 }
  ])('handles a zero limit without division by zero', async ({ requests, expected }) => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify({ subscription: { ...subscription, requests, limit: 0 } }))
    )
    expect((await fetchSyntheticRateLimits('placeholder')).session?.usedPercent).toBe(expected)
  })
  it('maps the legacy documented subscription', async () => {
    netFetch.mockResolvedValue(new Response(JSON.stringify({ subscription })))
    const result = await fetchSyntheticRateLimits(' placeholder-key ')
    expect(netFetch).toHaveBeenCalledWith(
      SYNTHETIC_QUOTAS_URL,
      expect.objectContaining({
        headers: { Authorization: 'Bearer placeholder-key', Accept: 'application/json' },
        redirect: 'error'
      })
    )
    expect(result.status).toBe('ok')
    expect(result.requestQuota).toEqual({
      requests: 27,
      limit: 135,
      renewsAt: Date.parse(subscription.renewsAt)
    })
    expect(result.session).toMatchObject({ usedPercent: 20, windowMinutes: 300 })
    expect(JSON.stringify(result)).not.toContain('placeholder-key')
  })

  it('uses the environment key when no override is set', async () => {
    vi.stubEnv('SYNTHETIC_API_KEY', 'environment-placeholder')
    netFetch.mockResolvedValue(new Response(JSON.stringify({ subscription })))
    await fetchSyntheticRateLimits('')
    expect(netFetch).toHaveBeenCalledWith(
      SYNTHETIC_QUOTAS_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer environment-placeholder' })
      })
    )
  })

  it('does not request quotas without a key', async () => {
    expect((await fetchSyntheticRateLimits('')).status).toBe('unavailable')
    expect(netFetch).not.toHaveBeenCalled()
  })

  it.each([0, 135, 200])('preserves %s requests and clamps the display', async (requests) => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify({ subscription: { ...subscription, requests } }))
    )
    const result = await fetchSyntheticRateLimits('placeholder')
    expect(result.requestQuota?.requests).toBe(requests)
    expect(result.session?.usedPercent).toBe(Math.min(100, (requests / 135) * 100))
  })

  it.each([
    { ...subscription, limit: -1 },
    { ...subscription, requests: -1 },
    { ...subscription, requests: '27' },
    { ...subscription, renewsAt: 'invalid' }
  ])('rejects malformed quotas', async (invalid) => {
    netFetch.mockResolvedValue(new Response(JSON.stringify({ subscription: invalid })))
    const result = await fetchSyntheticRateLimits('placeholder')
    expect(result.status).toBe('error')
    expect(result.requestQuota).toBeUndefined()
  })

  it.each([401, 403, 429, 500])(
    'handles HTTP %s without exposing response bodies',
    async (status) => {
      netFetch.mockResolvedValue(new Response('placeholder-secret', { status }))
      const result = await fetchSyntheticRateLimits('placeholder-secret')
      expect(result.status).toBe('error')
      expect(JSON.stringify(result)).not.toContain('placeholder-secret')
    }
  )

  it('redacts thrown network errors and passes cancellation to the request', async () => {
    const controller = new AbortController()
    netFetch.mockImplementation(async (_url, options: RequestInit) => {
      expect(options.signal?.aborted).toBe(true)
      throw new Error('Authorization: Bearer placeholder-secret')
    })
    controller.abort()
    const result = await fetchSyntheticRateLimits('placeholder-secret', controller.signal)
    expect(result.status).toBe('error')
    expect(JSON.stringify(result)).not.toContain('placeholder-secret')
  })
})
