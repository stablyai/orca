import { expect, it, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../structured-agent-command-resolution'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe'
  }
}

function sharedListingHarness() {
  const pending = new Map<string, PromiseWithResolvers<AgentModelCatalogSuccess>>()
  const listingFor = (identity: string) => {
    const held = pending.get(identity) ?? Promise.withResolvers<AgentModelCatalogSuccess>()
    pending.set(identity, held)
    return held
  }
  const discovery = listingFor('codex')
  const runs: {
    identity: string
    signal?: AbortSignal
    current?: () => boolean
    deadline?: number
  }[] = []
  const run = vi.fn(
    (identity: string, signal?: AbortSignal, operation?: StructuredAgentResolutionOperation) => {
      runs.push({ identity, signal, current: operation?.current, deadline: operation?.deadline })
      return new Promise<AgentModelCatalogSuccess>((resolve, reject) => {
        void listingFor(identity).promise.then(resolve)
        signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
      }).then((success) => {
        // The production probes check their owning operation before publishing.
        assertStructuredAgentResolutionCurrent(operation)
        return success
      })
    }
  )
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account' }),
    probes: {
      codex: Object.assign(vi.fn(), {
        resolve: async (
          _home: unknown,
          _cwd: string,
          _lookup: unknown,
          operation?: StructuredAgentResolutionOperation,
          folder?: string
        ) => {
          const identity = folder?.startsWith('/own') ? folder : 'codex'
          return {
            identity,
            run: (signal?: AbortSignal, owner = operation) => run(identity, signal, owner)
          }
        }
      })
    }
  })
  onTestFinished(() => {
    for (const held of pending.values()) {
      held.resolve(listing('late'))
    }
    return service.stop()
  })
  return { discovery, listingFor, runs, run, store, service }
}

it('finishes a shared listing for a folder that joined before the first reader gave up', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  void h.service.demand({ agent: 'codex', workspacePath: '/a', deadline: Date.now() + 1_000 })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  const b = h.service.read({
    agent: 'codex',
    workspacePath: '/b',
    waitForListing: true,
    deadline: Date.now() + 60_000
  })
  await vi.advanceTimersByTimeAsync(2_000)
  // The first reader is gone, but the listing it started is still running for the folder that joined.
  expect(h.runs[0]?.signal?.aborted).toBe(false)
  h.discovery.resolve({ ...listing('shared'), complete: true, configured: {} })
  await vi.advanceTimersByTimeAsync(0)
  expect(await b).toMatchObject({ models: [{ id: 'shared' }] })
  expect(h.run).toHaveBeenCalledOnce()
})

it("never answers a newly picked folder with the previous folder's late listing", async () => {
  const h = sharedListingHarness()
  const old = h.service.read({ agent: 'codex', workspacePath: '/own-old', waitForListing: true })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  const picked = h.service.read({ agent: 'codex', workspacePath: '/own-new', waitForListing: true })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
  h.listingFor('/own-old').resolve({ ...listing('old'), complete: true, configured: {} })
  expect(await old).toMatchObject({ models: [{ id: 'old' }] })
  expect(h.service.snapshot({ agent: 'codex', workspacePath: '/own-new' }).origin).toBe('unknown')
  h.listingFor('/own-new').resolve({ ...listing('new'), complete: true, configured: {} })
  expect(await picked).toMatchObject({ models: [{ id: 'new' }] })
  // A reader still asking for the old folder keeps its answer.
  expect(h.service.snapshot({ agent: 'codex', workspacePath: '/own-old' })).toMatchObject({
    models: [{ id: 'old' }]
  })
})

it('keeps a shared listing for an earlier-ending reader of the same folder when the first is cancelled', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  const first = h.service.captureRead({
    agent: 'codex',
    workspacePath: '/a',
    deadline: Date.now() + 60_000
  })
  void h.service.demand({ agent: 'codex', workspacePath: '/a', operation: first })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  const second = h.service.read({
    agent: 'codex',
    workspacePath: '/a',
    waitForListing: true,
    deadline: Date.now() + 30_000
  })
  await vi.advanceTimersByTimeAsync(0)
  first.controller.abort()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(h.runs[0]?.signal?.aborted).toBe(false)
  h.discovery.resolve({ ...listing('shared'), complete: true, configured: {} })
  await vi.advanceTimersByTimeAsync(0)
  expect(await second).toMatchObject({ models: [{ id: 'shared' }] })
  expect(h.run).toHaveBeenCalledOnce()
})

it('re-reads configured defaults on explicit reset even while the catalog is fresh', async () => {
  const h = sharedListingHarness()
  h.discovery.resolve({ ...listing('initial'), complete: true, configured: {} })
  await h.service.demand({ agent: 'codex' })
  expect(h.run).toHaveBeenCalledOnce()
  h.run.mockResolvedValue({ ...listing('configured'), complete: true, configured: {} })
  const answer = await h.service.read({
    agent: 'codex',
    waitForListing: true,
    requireConfiguredDefault: true
  })
  expect(h.run).toHaveBeenCalledTimes(2)
  if (answer.origin === 'unknown') {
    throw new Error('Configured default was not refreshed')
  }
  expect(answer.models.map((model) => model.id)).toEqual(['configured'])
})
