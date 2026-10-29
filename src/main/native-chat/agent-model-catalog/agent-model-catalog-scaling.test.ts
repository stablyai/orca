import { expect, it, vi } from 'vitest'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'
import type { AgentModelCatalogProbe } from './agent-model-catalog-discovery'
import type { AgentModelCatalogReadParams } from './agent-model-catalog-service-contract'

it('catalog-scale retires a many-scope frontier and releases actual listing waiters before recovery', async () => {
  for (const scopes of [5, 50]) {
    const store = new AgentModelCatalogStore()
    let active = 0
    let peak = 0
    let started = 0
    let cancelled = 0
    let identityReads = 0
    const perKeyReads = Array.from({ length: scopes }, () => 0)
    let pendingWaiters = 0
    let peakWaiters = 0
    let recover = false
    const pending = store.pendingListing.bind(store)
    vi.spyOn(store, 'pendingListing').mockImplementation((...args) => {
      const waiting = pending(...args)
      if (!waiting) {
        return null
      }
      peakWaiters = Math.max(peakWaiters, ++pendingWaiters)
      return waiting.finally(() => pendingWaiters--)
    })
    const probe = vi.fn<AgentModelCatalogProbe>(async (_home, options) => {
      started++
      if (recover) {
        return {
          origin: 'probe' as const,
          models: [{ id: 'recovered', label: 'Recovered', isDefault: true, efforts: [] }]
        }
      }
      peak = Math.max(peak, ++active)
      return new Promise<AgentModelCatalogSuccess>((_resolve, reject) => {
        const stop = () => {
          active--
          cancelled++
          reject(new Error('owner retired'))
        }
        options?.signal?.addEventListener('abort', stop, { once: true })
        if (options?.signal?.aborted) {
          stop()
        }
      })
    })
    const home = vi.fn(async () => ({ variable: 'HOME', path: '/generated-account' }))
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: home,
      probes: { opencode: probe },
      listsInChatFolder: new Set(['opencode'])
    })
    const params: AgentModelCatalogReadParams[] = Array.from({ length: scopes }, (_, index) => ({
      agent: 'opencode',
      workspace: {
        selector: `workspace-${index}`,
        identity: () => {
          identityReads++
          perKeyReads[index]++
          return `scope-${index}`
        },
        resolve: async () => ({ path: `/generated-project/${index}`, identity: `scope-${index}` })
      }
    }))
    const start = performance.now()
    try {
      const demands = params.map((request) => service.demand(request))
      const joined = params.map((request) => service.demand(request))
      expect(joined.every((promise, index) => promise === demands[index])).toBe(true)
      await vi.waitFor(() => expect(pendingWaiters).toBe(scopes))
      expect(started).toBe(2)
      expect(peak).toBe(2)
      expect(params.filter((request) => service.snapshot(request).listingInProgress).length).toBe(
        scopes
      )
      const pendingIdentityReads = identityReads
      expect(pendingIdentityReads).toBeGreaterThanOrEqual(scopes)
      perKeyReads.fill(0)
      service.snapshot(params[0])
      expect(perKeyReads[0]).toBeGreaterThan(0)
      expect(perKeyReads.slice(1)).toEqual(Array.from({ length: scopes - 1 }, () => 0))
      expect(peakWaiters).toBe(scopes)
      store.expireAgent('opencode')
      service.retireContext()
      await Promise.all([...demands, ...joined])
      expect(active).toBe(0)
      expect(cancelled).toBe(2)
      expect(started).toBe(2)
      expect(pendingWaiters).toBe(0)
      recover = true
      await service.demand(params[scopes - 1])
      expect(service.snapshot(params[scopes - 1])).toMatchObject({ models: [{ id: 'recovered' }] })
      expect(started).toBe(3)
      expect(pendingWaiters).toBe(0)
      process.stdout.write(
        `CATALOG_FRONTIER ${JSON.stringify({
          scopes,
          callers: scopes * 2,
          scopeResolutions: home.mock.calls.length - 1,
          peakNativeFixtureCalls: peak,
          startedBeforeRetirement: started - 1,
          cancelled,
          peakWaiters,
          retainedWaiters: pendingWaiters,
          pendingIdentityReads,
          totalIdentityReads: identityReads,
          recoveryCalls: 1,
          elapsedMs: performance.now() - start
        })}\n`
      )
    } finally {
      service.stop()
      vi.restoreAllMocks()
    }
  }
})

it('settles owner deadlines and joined readers without releasing ignored native attempts early', async () => {
  vi.useFakeTimers()
  const store = new AgentModelCatalogStore()
  const attempts: ReturnType<typeof Promise.withResolvers<AgentModelCatalogSuccess>>[] = []
  let active = 0
  let peak = 0
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'HOME', path: '/account' }),
    listsInChatFolder: new Set(['opencode']),
    probes: {
      opencode: async () => {
        const attempt = Promise.withResolvers<AgentModelCatalogSuccess>()
        attempts.push(attempt)
        peak = Math.max(peak, ++active)
        try {
          return await attempt.promise
        } finally {
          active--
        }
      }
    }
  })
  const params = (workspacePath: string) => ({ agent: 'opencode', workspacePath })
  try {
    const a = service.demand(params('/a'))
    const joined = service.demand(params('/a'))
    const b = service.demand(params('/b'))
    expect(joined).toBe(a)
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toHaveLength(2)
    const read = service.read({ ...params('/a'), waitForListing: true })
    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.all([a, joined, b, read])
    expect(service.snapshot(params('/a')).listingInProgress).toBeUndefined()
    expect(active).toBe(2)
    const replacement = service.demand(params('/a'))
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toHaveLength(2)
    attempts[0]!.resolve({
      origin: 'probe',
      models: [{ id: 'old', label: 'Old', efforts: [], isDefault: true }]
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toHaveLength(3)
    expect(peak).toBe(2)
    expect(service.snapshot(params('/a')).origin).toBe('unknown')
    attempts[2]!.resolve({
      origin: 'probe',
      models: [{ id: 'new', label: 'New', efforts: [], isDefault: true }]
    })
    await vi.advanceTimersByTimeAsync(0)
    await replacement
    expect(service.snapshot(params('/a'))).toMatchObject({ models: [{ id: 'new' }] })
  } finally {
    service.stop()
    for (const attempt of attempts) {
      attempt.resolve({ origin: 'probe', models: [] })
    }
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  }
})
