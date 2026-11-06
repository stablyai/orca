import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeSearchService } from '../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault/search/ai-vault-search-client'

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
    expect(await sessionSearchServiceStatus({}, 'ipc')).toMatchObject({
      enabled: false,
      phase: 'idle',
      generation: 0
    })
    await expect(searchSessionService({ query: 42 }, 'ipc')).rejects.toThrow()
  })
  it.each(['ipc', 'runtime', 'relay'] as const)(
    'withholds degraded-root paths from %s status per the exposure policy',
    async (transport) => {
      const service = fakeSearchService()
      service.status.mockResolvedValue({
        ...unavailableSessionSearchStatus(),
        enabled: true,
        phase: 'degraded',
        degradedRoots: [{ root: '/host/projects', reason: 'could not be listed' }]
      })
      setSessionSearchService(service)
      expect((await sessionSearchServiceStatus({}, transport)).degradedRoots).toEqual([
        transport === 'relay'
          ? { reason: 'Source root could not be verified.' }
          : { root: '/host/projects', reason: 'could not be listed' }
      ])
    }
  )
  it('searches indexed data by default, drops legacy options and suppresses unsolicited diagnostics', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    const result = await searchSessionService(
      { query: 'needle', tier: 'conversation', refresh: true },
      'ipc'
    )
    expect(service.reconcile).not.toHaveBeenCalled()
    expect(service.search).toHaveBeenCalledWith(
      {
        query: 'needle',
        limit: 20
      },
      undefined
    )
    expect(result).not.toHaveProperty('debug')
    expect(await searchSessionService({ query: 'needle', debug: true }, 'ipc')).toHaveProperty(
      'debug'
    )
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
})
