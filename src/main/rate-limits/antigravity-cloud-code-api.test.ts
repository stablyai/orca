import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchAntigravityQuota } from './antigravity-cloud-code-api'

const cancel = vi.fn()

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    body: { cancel }
  } as unknown as Response
}

const QUOTA_BODY = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          resetTime: '2026-09-11T05:00:13Z',
          remainingFraction: 0.79675514
        }
      ]
    }
  ]
}

function routeOk(url: string): Response {
  if (url.includes('loadCodeAssist')) {
    return makeResponse(200, {
      cloudaicompanionProject: 'proj-1',
      currentTier: { id: 'free-tier' }
    })
  }
  if (url.includes('retrieveUserQuotaSummary')) {
    return makeResponse(200, QUOTA_BODY)
  }
  // Why: an unrouted URL must fail loudly rather than pass the test silently.
  return makeResponse(500, {})
}

function lastInit(match: string): RequestInit {
  const call = netFetchMock.mock.calls.findLast(([url]) => String(url).includes(match))
  return (call?.[1] ?? {}) as RequestInit
}

describe('fetchAntigravityQuota', () => {
  beforeEach(() => {
    cancel.mockReset()
    netFetchMock.mockReset()
    netFetchMock.mockImplementation((url: string) => Promise.resolve(routeOk(url)))
  })

  it('identifies itself as Antigravity, which is what unlocks the quota grant', async () => {
    await fetchAntigravityQuota('token-1')
    for (const method of ['loadCodeAssist', 'retrieveUserQuotaSummary']) {
      const headers = lastInit(method).headers as Record<string, string>
      expect(headers['User-Agent']).toMatch(/antigravity/i)
    }
  })

  it('asks for the Antigravity project rather than the Gemini CLI one', async () => {
    await fetchAntigravityQuota('token-1')
    expect(JSON.parse(String(lastInit('loadCodeAssist').body))).toEqual({
      metadata: { ideType: 'ANTIGRAVITY' }
    })
  })

  it('returns the grouped windows on success', async () => {
    const result = await fetchAntigravityQuota('token-1')
    expect(result).toEqual({ status: 'ok', groups: QUOTA_BODY.groups })
  })

  it('passes the resolved project to the quota call', async () => {
    await fetchAntigravityQuota('token-1')
    expect(JSON.parse(String(lastInit('retrieveUserQuotaSummary').body))).toEqual({
      project: 'proj-1'
    })
  })

  it('reports a missing project as an entitlement gap, not an error', async () => {
    netFetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('loadCodeAssist') ? makeResponse(200, { allowedTiers: [] }) : routeOk(url)
      )
    )
    expect(await fetchAntigravityQuota('token-1')).toEqual({ status: 'not-entitled' })
  })

  it('reports a 403 from the quota call as an entitlement gap', async () => {
    netFetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('retrieveUserQuotaSummary') ? makeResponse(403, {}) : routeOk(url)
      )
    )
    expect(await fetchAntigravityQuota('token-1')).toEqual({ status: 'not-entitled' })
  })

  it('reports a rejected token as unauthorized', async () => {
    netFetchMock.mockImplementation(() => Promise.resolve(makeResponse(401, {})))
    expect(await fetchAntigravityQuota('token-1')).toEqual({ status: 'unauthorized' })
  })

  it('falls back to the stable host when the daily host errors', async () => {
    netFetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('daily-') ? makeResponse(500, {}) : routeOk(url))
    )
    const result = await fetchAntigravityQuota('token-1')
    expect(result.status).toBe('ok')
    expect(netFetchMock.mock.calls.some(([url]) => String(url).includes('daily-'))).toBe(true)
  })

  it('does not retry the second host on an account-level verdict', async () => {
    netFetchMock.mockImplementation(() => Promise.resolve(makeResponse(401, {})))
    await fetchAntigravityQuota('token-1')
    expect(netFetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels response bodies it will not read', async () => {
    netFetchMock.mockImplementation(() => Promise.resolve(makeResponse(500, {})))
    await fetchAntigravityQuota('token-1')
    expect(cancel).toHaveBeenCalled()
  })

  it('sends the caller abort signal alongside its own timeout', async () => {
    const controller = new AbortController()
    await fetchAntigravityQuota('token-1', controller.signal)
    expect(lastInit('loadCodeAssist').signal).toBeInstanceOf(AbortSignal)
  })
})
