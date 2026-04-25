import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchOpenCodeGoRateLimits, normalizeCookieInput } from './opencode-go-usage-fetcher'

const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'

function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  } as Response
}

const USAGE_PAGE_WITH_MONTHLY = `
<html><script>
window.__data = {
  rollingUsage: { usagePercent: 30, resetInSec: 7200 },
  weeklyUsage: { usagePercent: 51, resetInSec: 259200 },
  monthlyUsage: { usagePercent: 89, resetInSec: 1296000 }
}
</script></html>
`

const USAGE_PAGE_NO_MONTHLY = `
<html><script>
window.__data = {
  rollingUsage: { usagePercent: 10, resetInSec: 3600 },
  weeklyUsage: { usagePercent: 20, resetInSec: 86400 }
}
</script></html>
`

const WORKSPACES_RESPONSE = 'id: "wrk_TESTWORKSPACEID123"'

describe('fetchOpenCodeGoRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-24T12:00:00.000Z'))
    netFetchMock.mockReset()
  })

  it('returns unavailable when cookie is empty', async () => {
    const result = await fetchOpenCodeGoRateLimits('')

    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('opencode-go')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.monthly).toBeNull()
    expect(result.error).toBe('Session cookie not configured')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns unavailable when cookie is only whitespace', async () => {
    const result = await fetchOpenCodeGoRateLimits('   ')

    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns error when cookie has no auth or __Host-auth name', async () => {
    const result = await fetchOpenCodeGoRateLimits('session=abc123; other=xyz')

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/No auth cookie found/)
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  describe('normalizeCookieInput', () => {
    it('returns empty string unchanged', () => {
      expect(normalizeCookieInput('')).toBe('')
      expect(normalizeCookieInput('   ')).toBe('')
    })

    it('wraps a bare token as auth=<token>', () => {
      expect(normalizeCookieInput('Fe26.2**abc123')).toBe('auth=Fe26.2**abc123')
    })

    it('leaves auth=... unchanged', () => {
      expect(normalizeCookieInput('auth=Fe26.2**abc123')).toBe('auth=Fe26.2**abc123')
    })

    it('leaves __Host-auth=... unchanged', () => {
      expect(normalizeCookieInput('__Host-auth=token')).toBe('__Host-auth=token')
    })

    it('leaves multi-pair cookie headers unchanged', () => {
      expect(normalizeCookieInput('auth=tok; other=val')).toBe('auth=tok; other=val')
    })

    it('trims surrounding whitespace before wrapping', () => {
      expect(normalizeCookieInput('  Fe26.2**abc  ')).toBe('auth=Fe26.2**abc')
    })

    it('does not wrap unknown or malformed tokens', () => {
      expect(normalizeCookieInput('invalid token format')).toBe('invalid token format')
      expect(normalizeCookieInput('{}')).toBe('{}')
      expect(normalizeCookieInput('{"token":"abc"}')).toBe('{"token":"abc"}')
    })
  })

  it('accepts a bare token (auto-wraps to auth=<token>)', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(USAGE_PAGE_WITH_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits('Fe26.2**baretoken')

    expect(result.status).toBe('ok')
    // Cookie sent to the server must be auth=<token>, not the bare value.
    expect(netFetchMock.mock.calls[0][1].headers.Cookie).toBe('auth=Fe26.2**baretoken')
  })

  it('uses GET /_server?id=<hash> with correct headers for workspaces', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(USAGE_PAGE_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(netFetchMock).toHaveBeenNthCalledWith(
      1,
      `https://opencode.ai/_server?id=${WORKSPACES_SERVER_ID}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Cookie: 'auth=mytoken',
          'X-Server-Id': WORKSPACES_SERVER_ID
        })
      })
    )
  })

  it('fetches usage from /workspace/<id>/go after resolving workspace ID', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(USAGE_PAGE_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      'https://opencode.ai/workspace/wrk_TESTWORKSPACEID123/go',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('returns ok with session, weekly, and monthly windows', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(USAGE_PAGE_WITH_MONTHLY))

    const now = Date.now()
    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()

    expect(result.session).toEqual({
      usedPercent: 30,
      windowMinutes: 300,
      resetsAt: now + 7200 * 1000,
      resetDescription: null
    })
    expect(result.weekly).toEqual({
      usedPercent: 51,
      windowMinutes: 10080,
      resetsAt: now + 259200 * 1000,
      resetDescription: null
    })
    expect(result.monthly).toEqual({
      usedPercent: 89,
      windowMinutes: 43200,
      resetsAt: now + 1296000 * 1000,
      resetDescription: null
    })
  })

  it('returns ok with null monthly when monthlyUsage is absent', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(USAGE_PAGE_NO_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(10)
    expect(result.weekly?.usedPercent).toBe(20)
    expect(result.monthly).toBeNull()
  })

  it('caps usedPercent at 100 and floors at 0', async () => {
    const page = `
      rollingUsage: { usagePercent: 150, resetInSec: 3600 }
      weeklyUsage: { usagePercent: -5, resetInSec: 86400 }
    `
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(page))

    const result = await fetchOpenCodeGoRateLimits('auth=token')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(100)
    expect(result.weekly?.usedPercent).toBe(0)
  })

  it('handles nested objects between key and fields (robustness fix)', async () => {
    const page = `
      rollingUsage: {
        meta: { lastUpdate: "2023-01-01", status: "active" },
        usagePercent: 42,
        resetInSec: 1337
      }
      weeklyUsage: {
        details: { tier: "pro" },
        usagePercent: 68,
        resetInSec: 86400
      }
    `
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(page))

    const result = await fetchOpenCodeGoRateLimits('auth=token')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(42)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.usedPercent).toBe(68)
  })

  it('skips workspace lookup when workspaceIdOverride is provided', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(USAGE_PAGE_WITH_MONTHLY))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken', 'wrk_OVERRIDE123')

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(netFetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/workspace/wrk_OVERRIDE123/go',
      expect.anything()
    )
    expect(result.status).toBe('ok')
  })

  it('filters cookie to auth name only', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse(USAGE_PAGE_WITH_MONTHLY))

    await fetchOpenCodeGoRateLimits('session=secret; auth=realtoken; tracking=xyz')

    const firstCall = netFetchMock.mock.calls[0]
    expect(firstCall[1].headers.Cookie).toBe('auth=realtoken')
  })

  it('returns error on 404 from workspaces fetch', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('Not Found', 404))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Workspaces fetch failed (404)')
    expect(result.session).toBeNull()
  })

  it('returns error on 401 from workspaces fetch', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Workspaces fetch failed (401)')
  })

  it('returns error when no workspace ID found in response', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('no workspace id here'))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/No workspace ID found/)
  })

  it('returns error on non-ok usage page response', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse('Not Found', 404))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Usage page fetch failed (404)')
  })

  it('returns error when usage data cannot be parsed from page', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse(WORKSPACES_RESPONSE))
      .mockResolvedValueOnce(makeResponse('<html>no usage data here</html>'))

    const result = await fetchOpenCodeGoRateLimits('auth=mytoken')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Could not parse usage data from page')
  })

  it('never logs the cookie in error messages', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('network timeout'))

    const result = await fetchOpenCodeGoRateLimits('auth=secret123')

    expect(result.status).toBe('error')
    expect(result.error).toBe('network timeout')
    expect(result.error).not.toContain('secret123')
  })
})
