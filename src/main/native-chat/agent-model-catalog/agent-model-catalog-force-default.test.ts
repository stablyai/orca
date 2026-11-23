import { expect, it, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../agent-launch/structured-agent-command-resolution'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { AgentModelCatalogProgress } from './agent-model-catalog-discovery'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'

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
    (
      identity: string,
      signal?: AbortSignal,
      operation?: StructuredAgentResolutionOperation,
      _publish?: AgentModelCatalogProgress
    ) => {
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
            run: (
              signal?: AbortSignal,
              owner = operation,
              _selected?: readonly string[],
              publish?: AgentModelCatalogProgress
            ) => run(identity, signal, owner, publish)
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

it.each([false, true])(
  'settles an identical final observation, including eviction (evicted=%s)',
  async (evicted) => {
    const store = new AgentModelCatalogStore()
    let first: unknown
    const success = { ...listing('same'), complete: true }
    const result = await store.refresh('same', 'codex', async (_selected, _owner, publish) => {
      publish?.(success, true)
      first = store.get('same')
      if (evicted) {
        for (let index = 0; index < 256; index++) {
          store.recordSuccess(`other-${index}`, 'codex', success, 'discovery')
        }
        expect(store.get('same')).toBeNull()
      }
      return success
    })
    expect(result?.models[0]?.id).toBe('same')
    if (!evicted) {
      expect(store.get('same')).toBe(first)
    }
    expect(store.get('same')?.models[0]?.id).toBe('same')
    expect(store.failure('same')).toBeNull()
    expect(store.isListing('same')).toBe(false)
    expect(store.probeDue('same')).toBe(false)
  }
)
