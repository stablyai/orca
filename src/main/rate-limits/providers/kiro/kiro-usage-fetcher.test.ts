import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KiroCliCredentialsReadResult } from '../../../foreign-sqlite-readers/kiro-cli-credentials-result'
import { fetchKiroRateLimits, resolveKiroCliDatabasePath } from './kiro-usage-fetcher'

// The reader is injected so no test can open the developer's real kiro-cli database.
vi.mock('../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readKiroCliCredentials: vi.fn(async () => {
    throw new Error('tests must inject readCredentials')
  })
}))

const NOW = new Date('2026-11-02T06:00:00.000Z')
const RESET_SECONDS = Date.parse('2026-12-01T00:00:00.000Z') / 1000
const PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:111122223333:profile/FAKEPROFILE'

function signedIn(
  overrides: Partial<{ accessToken: string; expiresAt: string | null; profileArn: string }> = {}
): (dbPath: string) => Promise<KiroCliCredentialsReadResult> {
  return async () => ({
    status: 'ok',
    credentials: {
      accessToken: 'fake-access',
      expiresAt: '2026-11-02T07:00:00.000000Z',
      profileArn: PROFILE_ARN,
      ...overrides
    }
  })
}

// Shape captured from a real GetUsageLimits answer; every value is fake.
function usageLimitsPayload(
  credit: Record<string, unknown> = {},
  overageStatus = 'DISABLED'
): Record<string, unknown> {
  return {
    daysUntilReset: 29,
    limits: [],
    nextDateReset: RESET_SECONDS,
    overageConfiguration: { overageStatus },
    subscriptionInfo: { subscriptionTitle: 'KIRO PRO MAX', type: 'Q_DEVELOPER_STANDALONE_PRO' },
    usageBreakdownList: [
      {
        bonuses: [],
        currency: 'USD',
        currentOveragesWithPrecision: 0,
        currentUsageWithPrecision: 250,
        nextDateReset: RESET_SECONDS,
        overageCapWithPrecision: 1000,
        overageRate: 0.04,
        resourceType: 'CREDIT',
        unit: 'INVOCATIONS',
        usageLimitWithPrecision: 1000,
        ...credit
      }
    ]
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/x-amz-json-1.0' }
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('fetchKiroRateLimits', () => {
  it('hides the meter when kiro-cli is not signed in', async () => {
    const result = await fetchKiroRateLimits({
      dbPath: 'unused',
      readCredentials: async () => ({ status: 'missing' })
    })

    expect(result).toMatchObject({
      provider: 'kiro',
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials' }
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports an unreadable kiro-cli database as an error', async () => {
    const result = await fetchKiroRateLimits({
      dbPath: 'unused',
      readCredentials: async () => ({ status: 'error', error: 'Unable to read the Kiro CLI login' })
    })

    expect(result).toMatchObject({ status: 'error', error: 'Unable to read the Kiro CLI login' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks GetUsageLimits for the profile and maps plan credits to the monthly window', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(usageLimitsPayload()))

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://codewhisperer.us-east-1.amazonaws.com/')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'X-Amz-Target': 'AmazonCodeWhispererService.GetUsageLimits',
        Authorization: 'Bearer fake-access'
      },
      body: JSON.stringify({ profileArn: PROFILE_ARN })
    })
    expect(result).toMatchObject({
      provider: 'kiro',
      status: 'ok',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 25,
        windowMinutes: 30 * 24 * 60,
        resetsAt: RESET_SECONDS * 1000
      },
      extraUsage: null,
      planType: 'KIRO PRO MAX',
      usageMetadata: { source: 'oauth', credentialSource: 'kiro-cli' }
    })
    // The renderer gets a per-process hash, never the ARN itself.
    expect(result.usageMetadata?.authProvenance).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(result)).not.toContain('111122223333')
  })

  it('keeps overage out of plan usage and reports the remaining overage credits', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        usageLimitsPayload(
          { currentUsageWithPrecision: 1300, currentOveragesWithPrecision: 300 },
          'ENABLED'
        )
      )
    )

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(result.monthly?.usedPercent).toBe(100)
    expect(result.extraUsage).toEqual({
      unit: 'credits',
      enabled: true,
      disabledReason: null,
      resetsAt: RESET_SECONDS * 1000,
      balance: 700,
      unlimited: false
    })
  })

  it('clamps plan usage that bonus spend pushes past the plan limit', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(usageLimitsPayload({ currentUsageWithPrecision: 1200, bonuses: [{}] }))
    )

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(result.monthly?.usedPercent).toBe(100)
  })

  it('asks kiro-cli to refresh an expired token without calling the service', async () => {
    const result = await fetchKiroRateLimits({
      dbPath: 'unused',
      readCredentials: signedIn({ expiresAt: '2026-11-02T05:59:59.000000Z' })
    })

    expect(result).toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'delegated-refresh-required' }
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([401, 403])('asks kiro-cli to refresh when the service answers %i', async (status) => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: 'denied' }, status))

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(result.usageMetadata?.failureKind).toBe('delegated-refresh-required')
  })

  it.each([
    [429, 'rate-limited'],
    [500, 'server']
  ] as const)('maps HTTP %i to %s', async (status, failureKind) => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}, status))

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(result).toMatchObject({
      status: 'error',
      error: `Kiro usage request failed (${status})`,
      usageMetadata: { failureKind }
    })
  })

  it('redacts the access token from network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('socket closed for fake-access'))

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(result).toMatchObject({
      status: 'error',
      error: 'socket closed for [redacted]',
      usageMetadata: { failureKind: 'network' }
    })
  })

  it('does not call an unknown region', async () => {
    const result = await fetchKiroRateLimits({
      dbPath: 'unused',
      readCredentials: signedIn({
        profileArn: 'arn:aws:codewhisperer:ap-south-1:111122223333:profile/FAKEPROFILE'
      })
    })

    expect(result).toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the Frankfurt endpoint for an eu-central-1 profile', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(usageLimitsPayload()))

    await fetchKiroRateLimits({
      dbPath: 'unused',
      readCredentials: signedIn({
        profileArn: 'arn:aws:codewhisperer:eu-central-1:111122223333:profile/FAKEPROFILE'
      })
    })

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://q.eu-central-1.amazonaws.com/')
  })

  it.each([
    ['no credit breakdown', { usageBreakdownList: [] }],
    ['a zero plan limit', usageLimitsPayload({ usageLimitWithPrecision: 0 })],
    ['overage above total usage', usageLimitsPayload({ currentOveragesWithPrecision: 400 })]
  ])('reports %s as a parse error', async (_label, payload) => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(payload))

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(result).toMatchObject({ status: 'error', usageMetadata: { failureKind: 'parse' } })
  })

  it('drops an implausible reset date instead of inventing one', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(usageLimitsPayload({ nextDateReset: RESET_SECONDS * 1000 }))
    )

    const result = await fetchKiroRateLimits({ dbPath: 'unused', readCredentials: signedIn() })

    expect(result.monthly?.resetsAt).toBeNull()
  })
})

describe('resolveKiroCliDatabasePath', () => {
  it('uses LOCALAPPDATA on Windows', () => {
    expect(
      resolveKiroCliDatabasePath(
        { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
        'C:\\Users\\dev',
        'win32'
      )
    ).toMatch(/kiro-cli[\\/]data\.sqlite3$/)
  })

  it('uses Application Support on macOS', () => {
    expect(resolveKiroCliDatabasePath({}, '/Users/dev', 'darwin')).toMatch(
      /Library[\\/]Application Support[\\/]kiro-cli[\\/]data\.sqlite3$/
    )
  })

  it('uses XDG_DATA_HOME on Linux, falling back to ~/.local/share', () => {
    expect(resolveKiroCliDatabasePath({ XDG_DATA_HOME: '/data' }, '/home/dev', 'linux')).toMatch(
      /^[\\/]data[\\/]kiro-cli[\\/]data\.sqlite3$/
    )
    expect(resolveKiroCliDatabasePath({}, '/home/dev', 'linux')).toMatch(
      /\.local[\\/]share[\\/]kiro-cli[\\/]data\.sqlite3$/
    )
  })
})
