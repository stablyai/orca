import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())
const files = vi.hoisted<{ map: Map<string, string>; readError: Error | null }>(() => ({
  map: new Map(),
  readError: null
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.map.has(path),
  readFileSync: (path: string) => {
    if (files.readError) {
      throw files.readError
    }
    const contents = files.map.get(path)
    if (contents === undefined) {
      throw new Error('ENOENT')
    }
    return contents
  }
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

import { fetchCursorRateLimits } from './cursor-fetcher'

const AUTH_PATH = '/home/test/.config/cursor/auth.json'
const CLI_CONFIG_PATH = '/home/test/.config/cursor/cli-config.json'

/** Minimal unsigned JWT carrying only the public claim the fetcher reads. */
function tokenWithSubject(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject }), 'utf-8').toString('base64url')
  return `header.${payload}.signature`
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

/** Shape captured from a live pro_plus account; cents, not dollars. */
const USAGE_SUMMARY = {
  billingCycleStart: '2026-09-01T22:25:14.000Z',
  billingCycleEnd: '2026-10-01T22:25:14.000Z',
  membershipType: 'pro_plus',
  isUnlimited: false,
  individualUsage: {
    plan: { enabled: true, used: 904, limit: 7000, remaining: 6096 },
    onDemand: { enabled: false, used: 0, limit: null, remaining: null }
  }
}

beforeEach(() => {
  files.map = new Map([
    [AUTH_PATH, JSON.stringify({ accessToken: tokenWithSubject('auth0|user_01ABC') })],
    [CLI_CONFIG_PATH, JSON.stringify({ authInfo: { userId: 12345, email: 'dev@example.com' } })]
  ])
  files.readError = null
  netFetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchCursorRateLimits', () => {
  it('maps the plan allowance to a monthly window', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_SUMMARY))

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('ok')
    expect(limits.error).toBeNull()
    expect(limits.planType).toBe('pro_plus')
    // 904 / 7000 = 12.91%, from the raw pair rather than the rounded percent fields.
    expect(limits.monthly?.usedPercent).toBeCloseTo(12.91, 2)
    expect(limits.monthly?.windowMinutes).toBe(43_200)
    expect(limits.monthly?.resetsAt).toBe(Date.parse('2026-10-01T22:25:14.000Z'))
    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
  })

  it('sends the origin headers the dashboard requires', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_SUMMARY))

    await fetchCursorRateLimits()

    const [url, init] = netFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(url).toBe('https://cursor.com/api/usage-summary')
    // Why: a bare cookie gets a 403 from every dashboard route — this is the
    // CSRF check, and dropping either header silently breaks the provider.
    expect(init.headers.Origin).toBe('https://cursor.com')
    expect(init.headers.Referer).toBe('https://cursor.com/dashboard')
    expect(init.headers.Cookie).toContain('WorkosCursorSessionToken=')
    // The subject claim wins over cli-config.json's numeric account id.
    expect(init.headers.Cookie).toContain('user_01ABC')
    expect(init.headers.Cookie).not.toContain('12345')
  })

  it('falls back to cli-config.json when the token carries no subject', async () => {
    files.map.set(AUTH_PATH, JSON.stringify({ accessToken: 'not-a-jwt' }))
    netFetchMock.mockResolvedValueOnce(jsonResponse(USAGE_SUMMARY))

    await fetchCursorRateLimits()

    const [, init] = netFetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers.Cookie).toContain('12345')
  })

  it('reports unavailable when signed out', async () => {
    files.map.delete(AUTH_PATH)

    const limits = await fetchCursorRateLimits()

    // Why: signed out is not a failure — 'error' would pin a status-bar alert.
    expect(limits.status).toBe('unavailable')
    expect(limits.error).toContain('cursor-agent login')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('treats a logged-out token-less auth file as signed out', async () => {
    files.map.set(AUTH_PATH, JSON.stringify({ refreshToken: 'only-refresh' }))

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('reports an expired session on 401 without leaking the path', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(null, 401))

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('error')
    expect(limits.error).toContain('cursor-agent login')
    expect(limits.usageMetadata?.failureKind).toBe('stale-token')
  })

  it('reports a server fault with its status code', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse(null, 503))

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('error')
    expect(limits.error).toContain('HTTP 503')
    expect(limits.monthly).toBeUndefined()
  })

  it('publishes the plan without a window for unlimited accounts', async () => {
    netFetchMock.mockResolvedValueOnce(
      jsonResponse({ ...USAGE_SUMMARY, isUnlimited: true, membershipType: 'ultra' })
    )

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('ok')
    expect(limits.planType).toBe('ultra')
    // Why: no ceiling to divide by — a bar here would be invented.
    expect(limits.monthly).toBeUndefined()
  })

  it('falls back to the legacy request quota when no plan allowance exists', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          billingCycleEnd: '2026-10-01T22:25:14.000Z',
          membershipType: 'free',
          individualUsage: { plan: { enabled: true, used: 0, limit: null } }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          'gpt-4': { numRequests: 120, maxRequestUsage: 500 },
          'gpt-3.5-turbo': { numRequests: 4, maxRequestUsage: 200 },
          startOfMonth: '2026-09-01T22:25:14.000Z'
        })
      )

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('ok')
    // Premium bucket wins: 120 / 500 = 24%.
    expect(limits.monthly?.usedPercent).toBeCloseTo(24, 5)
    expect(netFetchMock.mock.calls[1]?.[0]).toContain('/api/usage?user=user_01ABC')
  })

  it('reports unavailable when neither endpoint carries a quota', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({ membershipType: 'team', individualUsage: { plan: { enabled: false } } })
      )
      .mockResolvedValueOnce(jsonResponse({ 'gpt-4': { numRequests: 0, maxRequestUsage: null } }))

    const limits = await fetchCursorRateLimits()

    // Why: a healthy account with no exposed quota must not show a red alert.
    expect(limits.status).toBe('unavailable')
    expect(limits.planType).toBe('team')
    expect(limits.monthly).toBeUndefined()
  })

  it('surfaces a network failure as an error result rather than throwing', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('error')
    expect(limits.error).toBe('socket hang up')
    expect(limits.usageMetadata?.failureKind).toBe('network')
  })

  it('does not leak the auth path when the file is unreadable', async () => {
    files.readError = new Error(
      'EACCES: permission denied, open /home/test/.config/cursor/auth.json'
    )

    const limits = await fetchCursorRateLimits()

    expect(limits.status).toBe('error')
    expect(limits.error).not.toContain('/home/test')
    expect(limits.error).toBe('Unable to read Cursor auth file')
  })
})
