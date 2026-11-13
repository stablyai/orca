import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { runAgentModelCatalogSession } from './agent-model-catalog-probe-runner'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../agent-launch/structured-agent-command-resolution'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
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

it('keeps the admitted slot and publication until timeout teardown completes', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const store = new AgentModelCatalogStore()
  const admission = new PrioritySemaphore(1)
  const close = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const first = store.refresh(
    'first',
    'grok',
    async (_selected, owner) =>
      runAgentModelCatalogSession(
        () => ({
          close: () => {
            closing.resolve()
            return close.promise
          }
        }),
        async (_connection, ready) => {
          ready(
            async () => {},
            () => listing('partial')
          )
          return new Promise<AgentModelCatalogSuccess>(() => {})
        },
        { label: 'grok', signal: owner.signal }
      ),
    { admission, timeoutMs: 30_000 }
  )
  let secondStarted = false
  const second = store.refresh(
    'second',
    'grok',
    async () => {
      secondStarted = true
      return listing('second')
    },
    { admission, timeoutMs: 30_000 }
  )
  await vi.advanceTimersByTimeAsync(30_001)
  await closing.promise
  expect(secondStarted).toBe(false)
  expect(store.isListing('first')).toBe(true)
  expect(store.get('first')).toBeNull()
  close.resolve()
  expect((await first)?.models[0]?.id).toBe('partial')
  expect((await second)?.models[0]?.id).toBe('second')
})
