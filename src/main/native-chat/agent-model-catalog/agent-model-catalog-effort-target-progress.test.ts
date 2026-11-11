import { expect, it, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'

it("reports a picked OMP model's menu discovery as a listing in progress", async () => {
  const listings: PromiseWithResolvers<AgentModelCatalogSuccess>[] = []
  const probe = vi.fn((_home: unknown, _options?: { selectedModels?: readonly string[] }) => {
    const listing = Promise.withResolvers<AgentModelCatalogSuccess>()
    listings.push(listing)
    return listing.promise
  })
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'PI_CODING_AGENT_DIR', path: '/account' }),
    probes: { omp: probe }
  })
  onTestFinished(() => {
    for (const listing of listings) {
      listing.resolve({ origin: 'probe', models: [] })
    }
    return service.stop()
  })
  const params = { agent: 'omp', workspacePath: '/work' }
  void service.demand(params)
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
  listings[0]!.resolve({
    origin: 'probe',
    models: [
      { id: 'wide', label: 'Wide', isDefault: false, efforts: [{ value: 'high', label: 'high' }] },
      { id: 'narrow', label: 'Narrow', isDefault: false, efforts: [], effortsKnown: false }
    ]
  })
  await vi.waitFor(async () =>
    expect((await service.read(params)).listingInProgress).toBeUndefined()
  )

  // The picker reads once, as the RPC does, and waits for the listing only if told one runs.
  const picked = { ...params, selectedModel: 'narrow' }
  void service.demand(picked)
  expect(await service.read(picked)).toMatchObject({ listingInProgress: true })
  await vi.waitFor(() =>
    expect(probe).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ selectedModels: ['narrow'] })
    )
  )
})
