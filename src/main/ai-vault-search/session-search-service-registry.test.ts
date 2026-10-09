import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeSearchService } from '../../shared/ai-vault-search-test-fixture'
import {
  unavailableSessionSearchStatus,
  createSessionSearchClient
} from '../../shared/ai-vault-search-client'
import { AI_VAULT_AGENTS } from '../../shared/ai-vault-types'
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
  describe.each(['qoder', 'jcode'] as const)('%s history compatibility', (agent) => {
    it.each(['runtime', 'relay'] as const)(
      'negotiates hits before retrieval on %s, without widening explicit filters',
      async (transport) => {
        const service = fakeSearchService()
        setSessionSearchService(service)
        await searchSessionService(
          { query: 'proof', supportedAgents: ['claude'], filters: { agents: ['claude', agent] } },
          transport
        )
        expect(service.search).toHaveBeenLastCalledWith(
          { query: 'proof', limit: 20, filters: { agents: ['claude'] } },
          undefined
        )
        expect(
          await searchSessionService(
            { query: 'proof', supportedAgents: ['claude'], filters: { agents: [agent] } },
            transport
          )
        ).toMatchObject({ kind: 'results', hits: [], page: { cursor: null, hasMore: false } })
        expect(service.search).toHaveBeenCalledTimes(2)
        expect(service.reconcile).not.toHaveBeenCalled()
        const client = createSessionSearchClient(
          (method, request) =>
            method === 'aiVault.searchStatus'
              ? sessionSearchServiceStatus(request, transport)
              : searchSessionService(request, transport),
          transport
        )
        await client.searchSessions({ query: 'proof', filters: { agents: [agent] } })
        expect(service.search).toHaveBeenLastCalledWith(
          { query: 'proof', limit: 20, filters: { agents: [agent] } },
          undefined
        )
      }
    )
  })
  it('keeps the current catalog for same-build direct IPC calls', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    await searchSessionService({ query: 'proof', filters: { agents: ['qoder', 'jcode'] } }, 'ipc')
    expect(service.search).toHaveBeenCalledExactlyOnceWith(
      { query: 'proof', limit: 20, filters: { agents: ['qoder', 'jcode'] } },
      undefined
    )
    expect((await sessionSearchServiceStatus({}, 'ipc')).supportedAgents).toEqual(AI_VAULT_AGENTS)
  })
  it.each(['disabled', 'not-ready'] as const)(
    'preserves %s precedence for empty negotiated host intersections',
    async (reason) => {
      const service = fakeSearchService()
      service.search.mockResolvedValue({ kind: 'unavailable', reason })
      setSessionSearchService(service)
      expect(
        await searchSessionService(
          { query: 'proof', supportedAgents: [], filters: { agents: ['jcode'] } },
          'runtime'
        )
      ).toEqual({ kind: 'unavailable', reason })
      expect(service.search).toHaveBeenCalledExactlyOnceWith(
        { query: 'proof', limit: 20, filters: { agents: ['jcode'] } },
        { kind: 'resolved', paths: [''] }
      )
    }
  )
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
