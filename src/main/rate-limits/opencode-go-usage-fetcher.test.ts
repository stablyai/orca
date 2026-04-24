import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

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

  it('returns unavailable when cookie is only whitespace', async () => {
    const result = await fetchOpenCodeGoRateLimits('   ')

    expect(result.status).toBe('unavailable')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('returns correct primary and secondary windows for a valid response', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('some workspaces js'))
      .mockResolvedValueOnce(
        makeResponse(
          'window.__usage = { "primary": { "used": 150, "limit": 500 }, "secondary": { "used": 20, "limit": 100 } };'
        )
      )

    const result = await fetchOpenCodeGoRateLimits('session=abc123')

    expect(netFetchMock).toHaveBeenCalledTimes(2)
    expect(netFetchMock).toHaveBeenNthCalledWith(
      1,
      'https://opencode.ai/_server',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Cookie: 'session=abc123'
        }),
        body: JSON.stringify({ method: 'workspaces' })
      })
    )
    expect(netFetchMock).toHaveBeenNthCalledWith(
      2,
      'https://opencode.ai/_server',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Cookie: 'session=abc123'
        }),
        body: JSON.stringify({ method: 'subscription.get' })
      })
    )

    expect(result.status).toBe('ok')
    expect(result.provider).toBe('opencode-go')
    expect(result.error).toBeNull()
    expect(result.session).toEqual({
      usedPercent: 30,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    })
    expect(result.weekly).toEqual({
      usedPercent: 20,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    })
  })

  it('returns ok with null weekly when secondary limit is missing', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('some workspaces js'))
      .mockResolvedValueOnce(
        makeResponse('window.__usage = { "primary": { "used": 10, "limit": 100 } };')
      )

    const result = await fetchOpenCodeGoRateLimits('session=abc123')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(10)
    expect(result.weekly).toBeNull()
  })

  it('caps usedPercent at 100 and floors at 0', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('ok'))
      .mockResolvedValueOnce(
        makeResponse(
          'window.__usage = { "primary": { "used": 150, "limit": 100 }, "secondary": { "used": -10, "limit": 50 } };'
        )
      )

    const result = await fetchOpenCodeGoRateLimits('session=abc123')

    expect(result.status).toBe('ok')
    expect(result.session?.usedPercent).toBe(100)
    expect(result.weekly?.usedPercent).toBe(0)
  })

  it('returns error on 401 from workspaces fetch', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchOpenCodeGoRateLimits('session=abc123')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Workspaces fetch failed (401)')
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
  })

  it('returns error on 401 from subscription fetch', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('ok'))
      .mockResolvedValueOnce(makeResponse('Unauthorized', 401))

    const result = await fetchOpenCodeGoRateLimits('session=abc123')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Subscription fetch failed (401)')
  })

  it('returns error when usage data cannot be parsed', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('ok'))
      .mockResolvedValueOnce(makeResponse('window.__usage = {};'))

    const result = await fetchOpenCodeGoRateLimits('session=abc123')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Invalid usage data')
  })

  it('returns error when primary limit is zero', async () => {
    netFetchMock
      .mockResolvedValueOnce(makeResponse('ok'))
      .mockResolvedValueOnce(
        makeResponse('window.__usage = { "primary": { "used": 0, "limit": 0 } };')
      )

    const result = await fetchOpenCodeGoRateLimits('session=abc123')

    expect(result.status).toBe('error')
    expect(result.error).toBe('Invalid usage data')
  })

  it('never logs the cookie in error messages', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('network timeout'))

    const result = await fetchOpenCodeGoRateLimits('session=secret123')

    expect(result.status).toBe('error')
    expect(result.error).toBe('network timeout')
    expect(result.error).not.toContain('secret123')
  })
})
