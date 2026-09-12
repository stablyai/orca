import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeSearchService } from '../../shared/ai-vault-search-test-fixture'
import {
  setSessionSearchService,
  searchSessionService,
  sessionSearchServiceStatus
} from './session-search-service-registry'

afterEach(() => {
  setSessionSearchService(null)
  vi.useRealTimers()
})

describe('session search service registry', () => {
  it('answers without constructing an indexer and validates even when unavailable', async () => {
    expect(await searchSessionService({ query: 'needle' }, 'ipc')).toEqual({
      kind: 'unavailable',
      reason: 'no-service'
    })
    expect(await sessionSearchServiceStatus()).toMatchObject({
      enabled: false,
      phase: 'idle',
      generation: 0
    })
    await expect(searchSessionService({ query: 42 }, 'ipc')).rejects.toThrow()
  })
  it('searches indexed data by default, drops legacy options and suppresses unsolicited diagnostics', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    const result = await searchSessionService(
      { query: 'needle', tier: 'conversation', refresh: true },
      'ipc'
    )
    expect(service.reconcile).not.toHaveBeenCalled()
    expect(service.search).toHaveBeenCalledWith({ query: 'needle', limit: 20 })
    expect(result).not.toHaveProperty('debug')
    expect(await searchSessionService({ query: 'needle', debug: true }, 'ipc')).toHaveProperty(
      'debug'
    )
  })
  it('waits for reconcile before search, and clears its timeout', async () => {
    vi.useFakeTimers()
    const service = fakeSearchService()
    let release!: () => void
    service.reconcile.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    setSessionSearchService(service)
    const result = searchSessionService(
      { query: 'needle', freshness: 'wait-until-current' },
      'runtime'
    )
    await Promise.resolve()
    expect(service.search).not.toHaveBeenCalled()
    release()
    expect(await result).toMatchObject({ kind: 'results', truncated: { freshness: false } })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('searches after the default five-second bound and observes a late rejection', async () => {
    vi.useFakeTimers()
    const service = fakeSearchService()
    let reject!: (error: Error) => void
    service.reconcile.mockImplementation(
      () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise
        })
    )
    setSessionSearchService(service)
    const result = searchSessionService(
      { query: 'needle', freshness: 'wait-until-current' },
      'relay'
    )
    await vi.advanceTimersByTimeAsync(4_999)
    expect(service.search).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({
      kind: 'results',
      truncated: { freshness: true },
      hits: [expect.objectContaining({ source: { presence: 'present' } })]
    })
    reject(new Error('late failure'))
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates reconciliation failures before timeout and service unavailability', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    service.reconcile.mockRejectedValue(new Error('cannot reconcile'))
    await expect(
      searchSessionService({ query: 'needle', freshness: 'wait-until-current' }, 'ipc')
    ).rejects.toThrow('cannot reconcile')
    expect(service.search).not.toHaveBeenCalled()
    for (const reason of ['disabled', 'not-ready'] as const) {
      service.search.mockResolvedValue({ kind: 'unavailable', reason })
      expect(await searchSessionService({ query: 'needle' }, 'ipc')).toEqual({
        kind: 'unavailable',
        reason
      })
    }
  })
})
