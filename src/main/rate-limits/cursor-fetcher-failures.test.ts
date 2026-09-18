import { beforeEach, describe, expect, it, vi } from 'vitest'

const netFetch = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ net: { fetch: netFetch } }))

import { fetchCursorRateLimits } from './cursor-fetcher'

const auth = { status: 'ok', accessToken: 'private-cursor-token', source: 'cli' } as const

describe('Cursor usage request boundaries', () => {
  beforeEach(() => {
    netFetch.mockReset()
  })

  it('does not forward transport exception text containing credentials', async () => {
    netFetch.mockRejectedValue(new Error(`Request failed: Bearer ${auth.accessToken}`))
    const result = await fetchCursorRateLimits({ authReadResult: auth })
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(JSON.stringify(result)).not.toContain(auth.accessToken)
  })

  it('honors an HTTP Retry-After response without turning it into a server failure', async () => {
    netFetch.mockResolvedValue(
      new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })
    )
    const startedAt = Date.now()
    const result = await fetchCursorRateLimits({ authReadResult: auth })
    expect(result.usageMetadata?.failureKind).toBe('rate-limited')
    expect(result.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(startedAt + 120_000)
    expect(result.monthly).toBeUndefined()
  })

  it('forbids redirecting the authenticated request', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify({ planUsage: { totalPercentUsed: 20 } }))
    )
    await fetchCursorRateLimits({ authReadResult: auth })
    expect(netFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it('retains reported model pools when the total percentage is absent', async () => {
    netFetch.mockResolvedValue(
      new Response(JSON.stringify({ planUsage: { autoPercentUsed: 0, apiPercentUsed: 72 } }))
    )
    const result = await fetchCursorRateLimits({ authReadResult: auth })
    expect(result.status).toBe('ok')
    expect(result.monthly).toBeUndefined()
    expect(result.buckets?.map((bucket) => bucket.usedPercent)).toEqual([0, 72])
  })
})
