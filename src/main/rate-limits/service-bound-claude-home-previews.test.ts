import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimitService } from './service'
import { fetchBoundClaudeHomeUsage } from './claude-bound-home-usage'
import type { BoundClaudeHomeUsageResult } from './claude-bound-home-usage'
import {
  deferred,
  okProvider,
  resetRateLimitProviderMocks
} from './rate-limit-service-test-harness'

vi.mock('./claude-bound-home-usage', () => ({
  fetchBoundClaudeHomeUsage: vi.fn()
}))

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  consumeCodexRateLimitResetCredit: vi.fn(),
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./kimi-fetcher', () => ({
  fetchKimiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

vi.mock('./minimax/minimax-fetcher', () => ({
  fetchMiniMaxRateLimits: vi.fn()
}))

vi.mock('./grok-fetcher', () => ({
  fetchGrokRateLimits: vi.fn()
}))

vi.mock('./grok-auth', () => ({
  readGrokAuthSession: vi.fn(() => ({ status: 'missing' }))
}))

vi.mock('../minimax/minimax-cookie-store', () => ({
  hasMiniMaxSessionCookie: vi.fn(() => false)
}))

function okUsage(usedPercent: number): BoundClaudeHomeUsageResult {
  return { status: 'ok', rateLimits: okProvider('claude', usedPercent) }
}

describe('bound Claude home usage previews', () => {
  beforeEach(() => {
    resetRateLimitProviderMocks()
  })

  it('fetches one row per bound group and exposes it on the state', async () => {
    const service = new RateLimitService()
    service.setBoundClaudeHomesResolver(() => [
      { groupId: 'group-a', configDir: '/tmp/home-a' },
      { groupId: 'group-b', configDir: '/tmp/home-b' }
    ])
    vi.mocked(fetchBoundClaudeHomeUsage)
      .mockResolvedValueOnce(okUsage(11))
      .mockResolvedValueOnce({ status: 'expired', rateLimits: null })

    await service.fetchBoundClaudeHomesOnOpen()

    expect(fetchBoundClaudeHomeUsage).toHaveBeenCalledTimes(2)
    expect(fetchBoundClaudeHomeUsage).toHaveBeenNthCalledWith(
      1,
      '/tmp/home-a',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(service.getState().boundClaudeHomes).toEqual([
      {
        groupId: 'group-a',
        configDir: '/tmp/home-a',
        rateLimits: expect.objectContaining({ provider: 'claude' }),
        status: 'ok',
        updatedAt: expect.any(Number),
        isFetching: false
      },
      {
        groupId: 'group-b',
        configDir: '/tmp/home-b',
        rateLimits: null,
        status: 'expired',
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('marks rows as fetching while the sequential loop runs', async () => {
    const service = new RateLimitService()
    const pending = deferred<BoundClaudeHomeUsageResult>()
    service.setBoundClaudeHomesResolver(() => [{ groupId: 'group-a', configDir: '/tmp/home-a' }])
    vi.mocked(fetchBoundClaudeHomeUsage).mockReturnValueOnce(pending.promise)

    const inFlight = service.fetchBoundClaudeHomesOnOpen()
    await Promise.resolve()

    expect(service.getState().boundClaudeHomes).toEqual([
      {
        groupId: 'group-a',
        configDir: '/tmp/home-a',
        rateLimits: null,
        status: 'ok',
        updatedAt: 0,
        isFetching: true
      }
    ])

    pending.resolve(okUsage(4))
    await inFlight

    expect(service.getState().boundClaudeHomes?.[0]?.isFetching).toBe(false)
  })

  it('debounces repeated expand triggers for 60 seconds', async () => {
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.setBoundClaudeHomesResolver(() => [{ groupId: 'group-a', configDir: '/tmp/home-a' }])
      vi.mocked(fetchBoundClaudeHomeUsage).mockResolvedValue(okUsage(5))

      await service.fetchBoundClaudeHomesOnOpen()
      await service.fetchBoundClaudeHomesOnOpen()

      expect(fetchBoundClaudeHomeUsage).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(59_000)
      await service.fetchBoundClaudeHomesOnOpen()
      expect(fetchBoundClaudeHomeUsage).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(2_000)
      await service.fetchBoundClaudeHomesOnOpen()
      expect(fetchBoundClaudeHomeUsage).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops an in-flight result when the binding generation moves on', async () => {
    const service = new RateLimitService()
    const pending = deferred<BoundClaudeHomeUsageResult>()
    let bindings = [{ groupId: 'group-a', configDir: '/tmp/home-a' }]
    service.setBoundClaudeHomesResolver(() => bindings)
    vi.mocked(fetchBoundClaudeHomeUsage).mockReturnValueOnce(pending.promise)

    const inFlight = service.fetchBoundClaudeHomesOnOpen()
    await Promise.resolve()

    bindings = [{ groupId: 'group-a', configDir: '/tmp/home-moved' }]
    service.evictBoundClaudeHomeUsage('group-a')
    pending.resolve(okUsage(88))
    await inFlight

    expect(service.getState().boundClaudeHomes).toEqual([])
  })

  it('evicts a cached row when the group rebinds to another directory', async () => {
    const service = new RateLimitService()
    let bindings = [{ groupId: 'group-a', configDir: '/tmp/home-a' }]
    service.setBoundClaudeHomesResolver(() => bindings)
    vi.mocked(fetchBoundClaudeHomeUsage).mockResolvedValue(okUsage(9))

    await service.fetchBoundClaudeHomesOnOpen()
    expect(service.getState().boundClaudeHomes?.[0]?.configDir).toBe('/tmp/home-a')

    bindings = [{ groupId: 'group-a', configDir: '/tmp/home-b' }]

    expect(service.getState().boundClaudeHomes).toEqual([])
  })

  it('refetches a rebound group immediately instead of waiting out the 60-second debounce', async () => {
    // Why: with the row deleted but the debounce untouched, the next expand returns early and
    // `buildBoundClaudeHomeArray` skips a binding with no row and no fetching flag — so the group
    // reads as *absent* for up to 55s, the same "the binding did not save" misread as a stale row.
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      let bindings = [{ groupId: 'group-a', configDir: '/tmp/home-a' }]
      service.setBoundClaudeHomesResolver(() => bindings)
      vi.mocked(fetchBoundClaudeHomeUsage).mockResolvedValue(okUsage(9))

      await service.fetchBoundClaudeHomesOnOpen()
      expect(service.getState().boundClaudeHomes?.[0]?.configDir).toBe('/tmp/home-a')

      vi.advanceTimersByTime(5_000)
      bindings = [{ groupId: 'group-a', configDir: '/tmp/home-b' }]
      service.evictBoundClaudeHomeUsage('group-a')
      await service.fetchBoundClaudeHomesOnOpen()

      expect(fetchBoundClaudeHomeUsage).toHaveBeenCalledTimes(2)
      expect(service.getState().boundClaudeHomes?.[0]).toMatchObject({
        configDir: '/tmp/home-b',
        status: 'ok'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts a cached row when its group is deleted', async () => {
    const service = new RateLimitService()
    let bindings = [{ groupId: 'group-a', configDir: '/tmp/home-a' }]
    service.setBoundClaudeHomesResolver(() => bindings)
    vi.mocked(fetchBoundClaudeHomeUsage).mockResolvedValue(okUsage(9))

    await service.fetchBoundClaudeHomesOnOpen()
    expect(service.getState().boundClaudeHomes).toHaveLength(1)

    bindings = []

    expect(service.getState().boundClaudeHomes).toEqual([])
  })

  it('keeps the last-known row when a transient usage error hits a still-bound group', async () => {
    // Why: an unconditional delete makes the group vanish from the menu entirely on one dropped
    // request — the user reads a 500 as "the binding is gone".
    vi.useFakeTimers()
    try {
      const service = new RateLimitService()
      service.setBoundClaudeHomesResolver(() => [{ groupId: 'group-a', configDir: '/tmp/home-a' }])
      vi.mocked(fetchBoundClaudeHomeUsage).mockResolvedValueOnce(okUsage(40))

      await service.fetchBoundClaudeHomesOnOpen()
      expect(service.getState().boundClaudeHomes?.[0]?.rateLimits?.session?.usedPercent).toBe(40)

      vi.advanceTimersByTime(61_000)
      vi.mocked(fetchBoundClaudeHomeUsage).mockRejectedValueOnce(new Error('HTTP 500'))
      await service.fetchBoundClaudeHomesOnOpen()

      expect(service.getState().boundClaudeHomes).toEqual([
        {
          groupId: 'group-a',
          configDir: '/tmp/home-a',
          rateLimits: expect.objectContaining({ provider: 'claude' }),
          status: 'ok',
          updatedAt: expect.any(Number),
          isFetching: false
        }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a row whose binding moved mid-fetch without any evict call', async () => {
    // Why: production never calls evict on a rebind mid-flight; the live resolver comparison is
    // what has to catch it.
    const service = new RateLimitService()
    const pending = deferred<BoundClaudeHomeUsageResult>()
    let bindings = [{ groupId: 'group-a', configDir: '/tmp/home-a' }]
    service.setBoundClaudeHomesResolver(() => bindings)
    vi.mocked(fetchBoundClaudeHomeUsage).mockReturnValueOnce(pending.promise)

    const inFlight = service.fetchBoundClaudeHomesOnOpen()
    await Promise.resolve()

    bindings = [{ groupId: 'group-a', configDir: '/tmp/home-moved' }]
    pending.resolve(okUsage(88))
    await inFlight

    expect(service.getState().boundClaudeHomes).toEqual([])
  })

  it('surfaces a status row when the very first fetch for a binding fails', async () => {
    // Why: with no prior row to keep, the group disappeared from the section entirely — visually
    // identical to having no binding, so the user reads a 502 as "the binding did not save".
    const service = new RateLimitService()
    service.setBoundClaudeHomesResolver(() => [{ groupId: 'group-a', configDir: '/tmp/home-a' }])
    vi.mocked(fetchBoundClaudeHomeUsage).mockRejectedValueOnce(new Error('HTTP 502'))

    await service.fetchBoundClaudeHomesOnOpen()

    expect(service.getState().boundClaudeHomes).toEqual([
      {
        groupId: 'group-a',
        configDir: '/tmp/home-a',
        rateLimits: null,
        status: 'unavailable',
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('keeps one failing directory from aborting the rest of the batch', async () => {
    const service = new RateLimitService()
    service.setBoundClaudeHomesResolver(() => [
      { groupId: 'group-a', configDir: '/tmp/home-a' },
      { groupId: 'group-b', configDir: '/tmp/home-b' }
    ])
    vi.mocked(fetchBoundClaudeHomeUsage)
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValueOnce(okUsage(21))

    await service.fetchBoundClaudeHomesOnOpen()

    expect(service.getState().boundClaudeHomes).toEqual([
      {
        groupId: 'group-a',
        configDir: '/tmp/home-a',
        rateLimits: null,
        status: 'unavailable',
        updatedAt: expect.any(Number),
        isFetching: false
      },
      {
        groupId: 'group-b',
        configDir: '/tmp/home-b',
        rateLimits: expect.objectContaining({ provider: 'claude' }),
        status: 'ok',
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('aborts in-flight bound-home fetches on stop', async () => {
    const service = new RateLimitService()
    const capturedSignals: { bound?: AbortSignal } = {}
    service.setBoundClaudeHomesResolver(() => [{ groupId: 'group-a', configDir: '/tmp/home-a' }])
    vi.mocked(fetchBoundClaudeHomeUsage).mockImplementation(
      (_configDir, options) =>
        new Promise((resolve) => {
          capturedSignals.bound = options?.signal
          options?.signal?.addEventListener(
            'abort',
            () => resolve({ status: 'unreadable', rateLimits: null }),
            { once: true }
          )
        })
    )

    const inFlight = service.fetchBoundClaudeHomesOnOpen()
    await Promise.resolve()

    service.stop()

    expect(capturedSignals.bound?.aborted).toBe(true)

    await inFlight

    expect(service.getState().boundClaudeHomes).toEqual([])
  })
})
