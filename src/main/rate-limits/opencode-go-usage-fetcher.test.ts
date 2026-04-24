import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock }
}))

import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'

function makeResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body
  } as Response
}

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
    expect(result.error).toBeNull()
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns correct primary and secondary windows for a valid response', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('{id:"wrk_abc123",name:"workspace"}'))
      .mockResolvedValueOnce(
        makeResponse(
          '{rollingUsage:{usagePercent:45.5,resetInSec:3600},weeklyUsage:{usagePercent:12,resetInSec:604800}}'
        )
      )

    const result = await fetchOpenCodeGoRateLimits('session=valid')

    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('ok')
    expect(result.provider).toBe('opencode-go')
    expect(result.error).toBeNull()

    expect(result.session).toEqual({
      usedPercent: 45.5,
      windowMinutes: 300,
      resetsAt: Date.now() + 3600 * 1000,
      resetDescription: null
    })

    expect(result.weekly).toEqual({
      usedPercent: 12,
      windowMinutes: 10080,
      resetsAt: Date.now() + 604800 * 1000,
      resetDescription: null
    })
  })

  it('returns error on 401 response from workspace fetch', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchOpenCodeGoRateLimits('session=bad')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Workspace fetch failed (401)')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns error when response body is malformed and cannot be parsed', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('{id:"wrk_abc123"}'))
      .mockResolvedValueOnce(makeResponse('not javascript at all'))

    const result = await fetchOpenCodeGoRateLimits('session=valid')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Failed to parse usage data from response')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns error when workspace fetch succeeds but subscription fetch fails', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('{id:"wrk_abc123",name:"workspace"}'))
      .mockResolvedValueOnce(makeResponse('Internal Server Error', 500))

    const result = await fetchOpenCodeGoRateLimits('session=valid')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Subscription fetch failed (500)')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns error when workspace ID is not found in response', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('{items:[]}'))

    const result = await fetchOpenCodeGoRateLimits('session=valid')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Workspace ID not found in response')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('caps usedPercent at 100 and floors at 0', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('{id:"wrk_abc123"}'))
      .mockResolvedValueOnce(
        makeResponse(
          '{rollingUsage:{usagePercent:150,resetInSec:100},weeklyUsage:{usagePercent:-10,resetInSec:200}}'
        )
      )

    const result = await fetchOpenCodeGoRateLimits('session=valid')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(100)
    expect(result.weekly?.usedPercent).toBe(0)
  })

  it('works when weeklyUsage is missing but rollingUsage is present', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('{id:"wrk_abc123"}'))
      .mockResolvedValueOnce(makeResponse('{rollingUsage:{usagePercent:50,resetInSec:1000}}'))

    const result = await fetchOpenCodeGoRateLimits('session=valid')

    expect(result.status).toBe('ok')
    expect(result.session).not.toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('never logs the cookie in error messages', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('network timeout'))

    const result = await fetchOpenCodeGoRateLimits('session=super-secret')

    expect(result.status).toBe('error')
    expect(result.error).toBe('network timeout')
    expect(result.error).not.toContain('super-secret')
  })
})
