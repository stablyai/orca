import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCommandCodeRateLimits } from './command-code-usage-fetcher'
import { COMMAND_CODE_AUTH_FILE_NAME } from './command-code-usage-credentials'
import type { CommandCodeHomeResolution } from '../command-code/command-code-runtime-home'

const KEY = 'cc-test-key-0123456789'

let home: string
let homeResolution: CommandCodeHomeResolution

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-command-code-usage-'))
  homeResolution = { runtime: 'host', wslDistro: null, path: home }
  vi.stubGlobal('fetch', vi.fn())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-18T09:00:00.000Z'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

function writeAuthFile(apiKey = KEY): void {
  writeFileSync(
    join(home, COMMAND_CODE_AUTH_FILE_NAME),
    JSON.stringify({ apiKey, userName: 'dev' })
  )
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const WHOAMI = {
  success: true,
  user: { id: 'user_1', name: 'Dev', email: 'dev@example.com', userName: 'dev' },
  org: null
}

const CREDITS = {
  credits: { monthlyCredits: 69.88, purchasedCredits: 10, freeCredits: 0.12 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 7, cap: 14, exceeded: false, resetAt: 1_792_329_294_012 },
    weekly: { used: 3.5, cap: 35, exceeded: false, resetAt: 1_792_916_094_012 }
  },
  sandboxAccess: true,
  sandboxMinutes: { usedMinutes: 0, limitMinutes: 0, overageUsd: 0, resetAt: 1_793_491_200_000 }
}

const SUBSCRIPTIONS = {
  success: true,
  data: {
    status: 'active',
    planId: 'individual-goat',
    currentPeriodStart: '2026-10-18T08:14:41.000Z',
    currentPeriodEnd: '2026-11-18T08:14:41.000Z'
  }
}

const SUMMARY = { totalCost: 20, totalCount: 36, periodBasis: 'billing-period' }

function mockUsageApi(
  overrides: {
    whoami?: unknown
    credits?: unknown
    subscriptions?: unknown
    summary?: unknown
    /** When set, every request fails with this HTTP status. */
    status?: number
  } = {}
): void {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input)
    if (overrides.status && overrides.status >= 400) {
      return new Response('denied', { status: overrides.status })
    }
    if (url.includes('/alpha/whoami')) {
      return jsonResponse(overrides.whoami ?? WHOAMI)
    }
    if (url.includes('/alpha/billing/credits')) {
      return jsonResponse(overrides.credits ?? CREDITS)
    }
    if (url.includes('/alpha/billing/subscriptions')) {
      return jsonResponse(overrides.subscriptions ?? SUBSCRIPTIONS)
    }
    if (url.includes('/alpha/usage/summary')) {
      return jsonResponse(overrides.summary ?? SUMMARY)
    }
    return new Response('not found', { status: 404 })
  })
}

describe('fetchCommandCodeRateLimits', () => {
  it('returns unavailable without a CLI login and issues no request', async () => {
    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result).toMatchObject({
      provider: 'command-code',
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials' }
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a stopped WSL distro as unavailable without probing the share', async () => {
    vi.stubEnv('COMMAND_CODE_API_KEY', KEY)

    const result = await fetchCommandCodeRateLimits({
      home: { runtime: 'wsl', wslDistro: 'Ubuntu', path: null }
    })

    expect(result.status).toBe('unavailable')
    expect(result.error).toBe('WSL Command Code home unavailable for Ubuntu')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the host env override when no auth file exists', async () => {
    vi.stubEnv('COMMAND_CODE_API_KEY', KEY)
    mockUsageApi()

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('ok')
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe('https://api.commandcode.ai/alpha/whoami?limits=1')
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${KEY}`)
    expect(result.usageMetadata?.credentialSource).toBe('env:COMMAND_CODE_API_KEY')
  })

  it('maps credits, both rolling windows, the plan pool, and the plan name', async () => {
    writeAuthFile()
    mockUsageApi()

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result).toMatchObject({ provider: 'command-code', status: 'ok', planType: 'GOAT' })
    expect(result.session).toEqual({
      usedPercent: 50,
      windowMinutes: 300,
      resetsAt: 1_792_329_294_012,
      resetDescription: null
    })
    expect(result.weekly).toEqual({
      usedPercent: 10,
      windowMinutes: 10080,
      resetsAt: 1_792_916_094_012,
      resetDescription: null
    })
    // Why: the plan pool is spend + remaining (20 + 80), not a table lookup.
    expect(result.monthly).toEqual({
      usedPercent: 20,
      windowMinutes: 43_200,
      resetsAt: Date.parse('2026-11-18T08:14:41.000Z'),
      resetDescription: null
    })
    expect(result.extraUsage).toEqual({
      enabled: true,
      disabledReason: null,
      resetsAt: null,
      unit: 'credits',
      balance: 80,
      unlimited: false
    })
    const summaryUrl = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .find((url) => url.includes('/summary'))
    expect(summaryUrl).toBe(
      'https://api.commandcode.ai/alpha/usage/summary?since=2026-10-18T08%3A14%3A41.000Z'
    )
  })

  it('scopes every request to the org when the account belongs to one', async () => {
    writeAuthFile()
    mockUsageApi({
      whoami: { ...WHOAMI, org: { id: 'org_1', login: 'acme', name: 'Acme' } }
    })

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('ok')
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls).toContain('https://api.commandcode.ai/alpha/billing/credits?orgId=org_1')
    expect(urls).toContain('https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_1')
    expect(urls.some((url) => url.includes('/alpha/usage/summary?orgId=org_1&since='))).toBe(true)
  })

  it('publishes credits without rolling windows when the plan reports no limits', async () => {
    writeAuthFile()
    mockUsageApi({
      credits: { credits: CREDITS.credits, windowLimits: { limited: false }, sandboxAccess: false }
    })

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('ok')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.extraUsage?.unit === 'credits' && result.extraUsage.balance).toBe(80)
  })

  it('keeps credits when the subscription endpoint fails', async () => {
    writeAuthFile()
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/alpha/whoami')) {
        return jsonResponse(WHOAMI)
      }
      if (url.includes('/alpha/billing/subscriptions')) {
        return new Response('boom', { status: 500 })
      }
      if (url.includes('/alpha/billing/credits')) {
        return jsonResponse(CREDITS)
      }
      return new Response('not found', { status: 404 })
    })

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(50)
    expect(result.monthly).toBeNull()
    expect(result.planType).toBeNull()
  })

  it('classifies an expired sign-in without leaking the key', async () => {
    writeAuthFile()
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ apiKey: KEY }), { status: 401 })
    )

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('stale-token')
    expect(result.error).toBe('Command Code sign-in expired. Run `cmd login` to refresh it.')
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('redacts a credential echoed by a transport error', async () => {
    writeAuthFile()
    vi.mocked(fetch).mockRejectedValue(new Error(`socket closed for ${KEY}`))

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toBe('socket closed for [redacted]')
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('treats a non-JSON success body as a parse failure', async () => {
    writeAuthFile()
    vi.mocked(fetch).mockResolvedValue(new Response('<html>hi</html>', { status: 200 }))

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('fails as a server error when the alpha endpoints disappear', async () => {
    writeAuthFile()
    mockUsageApi({ status: 404 })

    const result = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toBe('Command Code usage request failed (404)')
  })

  it('changes the non-secret account identity when the key changes', async () => {
    writeAuthFile('first-key')
    vi.mocked(fetch).mockResolvedValue(new Response('denied', { status: 401 }))
    const first = await fetchCommandCodeRateLimits({ home: homeResolution })

    writeAuthFile('second-key')
    const second = await fetchCommandCodeRateLimits({ home: homeResolution })

    expect(first.usageMetadata?.authProvenance).toMatch(/^[a-f0-9]{64}$/)
    expect(second.usageMetadata?.authProvenance).not.toBe(first.usageMetadata?.authProvenance)
    expect(JSON.stringify([first, second])).not.toContain('first-key')
    expect(JSON.stringify([first, second])).not.toContain('second-key')
  })
})
