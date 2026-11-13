import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import { runAgentModelCatalogSession } from './agent-model-catalog-probe-runner'
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

it('keeps physical admission through late success and actual teardown', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const store = new AgentModelCatalogStore()
  const admission = new PrioritySemaphore(1)
  const close = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<AgentModelCatalogSuccess>()
  const first = store.refresh(
    'first',
    'grok',
    async (_selected, owner, publish) =>
      runAgentModelCatalogSession(
        () => ({
          close: () => {
            closing.resolve()
            return close.promise
          }
        }),
        async () => {
          publish?.(listing('partial'))
          const result = await answer.promise
          assertStructuredAgentResolutionCurrent(owner)
          return result
        },
        { label: 'grok', signal: owner.signal, timeoutMs: null }
      ),
    { admission }
  )
  let secondStarted = false
  const second = store.refresh(
    'second',
    'grok',
    async () => {
      secondStarted = true
      return listing('second')
    },
    { admission }
  )
  await vi.advanceTimersByTimeAsync(45_000)
  expect(store.get('first')?.models[0]?.id).toBe('partial')
  answer.resolve(listing('late'))
  await closing.promise
  expect(secondStarted).toBe(false)
  expect(store.isListing('first')).toBe(true)
  expect(store.get('first')?.models[0]?.id).toBe('partial')
  close.resolve()
  expect((await first)?.models[0]?.id).toBe('late')
  expect((await second)?.models[0]?.id).toBe('second')
})

it.each([false, true])(
  'keeps a slow successful listing after its reader leaves (saved=%s)',
  async (saved) => {
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const h = sharedListingHarness()
    if (saved) {
      const initial = h.service.read({ agent: 'codex', waitForListing: true })
      await vi.advanceTimersByTimeAsync(0)
      h.discovery.resolve({ ...listing('saved'), complete: true })
      await initial
      h.store.expireScopes('codex')
    }
    const answer = Promise.withResolvers<AgentModelCatalogSuccess>()
    h.run.mockImplementation((_identity, signal, operation) =>
      runAgentModelCatalogSession(
        () => ({ close: async () => {} }),
        async () => {
          const result = await answer.promise
          assertStructuredAgentResolutionCurrent(operation)
          return result
        },
        { label: 'cold', signal, timeoutMs: null }
      )
    )
    const reader = h.service.read({ agent: 'codex', waitForListing: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await reader).toMatchObject({ listingInProgress: true, waitExpired: true })
    expect(h.service.snapshot({ agent: 'codex' }).models?.[0]?.id).toBe(saved ? 'saved' : undefined)
    await vi.advanceTimersByTimeAsync(15_000)
    answer.resolve({ ...listing('slow-success'), complete: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(await h.service.read({ agent: 'codex', waitForListing: true })).toMatchObject({
      models: [{ id: 'slow-success' }]
    })
    expect(h.service.snapshot({ agent: 'codex' }).listingInProgress).toBeUndefined()
  }
)

it.each([true, false])(
  'delivers progress and waits for a changed observation (progress=%s)',
  async (progress) => {
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const h = sharedListingHarness()
    const answer = Promise.withResolvers<AgentModelCatalogSuccess>()
    let publish: AgentModelCatalogProgress | undefined
    h.run.mockImplementation((_identity, _signal, _operation, notify) => {
      publish = notify
      return answer.promise
    })
    const first = h.service.read({ agent: 'codex', waitForListing: true, progress })
    await vi.advanceTimersByTimeAsync(0)
    publish?.({ ...listing('listed'), complete: false })
    await vi.advanceTimersByTimeAsync(progress ? 0 : 30_000)
    expect(await first).toMatchObject({
      models: [{ id: 'listed', isDefault: false }],
      listingInProgress: true
    })
    expect((await first).waitExpired).toBe(progress ? undefined : true)
    let next: unknown
    const follow = h.service
      .read({ agent: 'codex', waitForListing: true, progress: true })
      .then((result) => {
        next = result
      })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(next).toBeUndefined()
    publish?.({ ...listing('listed'), complete: true, configured: { model: 'listed' } }, true)
    await follow
    expect(next).toMatchObject({
      models: [{ id: 'listed', isDefault: true }],
      listingInProgress: true
    })
    answer.resolve({ ...listing('listed'), complete: true, configured: { model: 'listed' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.service.snapshot({ agent: 'codex' }).listingInProgress).toBeUndefined()
  }
)

it('keeps an account verdict until discovery actually answers it, including optional failure', async () => {
  const store = new AgentModelCatalogStore()
  store.recordSuccess(
    'held',
    'codex',
    { ...listing('saved'), complete: true, unavailable: { reason: 'notSignedIn' } },
    'discovery'
  )
  store.expireFailure('held')
  await store.refresh('held', 'codex', async (_selected, _owner, publish) => {
    publish?.({ ...listing('listed'), complete: true }, false)
    return { ...listing('listed'), complete: true }
  })
  expect(store.failure('held')?.unavailable).toEqual({ reason: 'notSignedIn' })
  await store.refresh('held', 'codex', async (_selected, _owner, publish) => {
    publish?.({ ...listing('listed'), complete: true }, true)
    return { ...listing('listed'), complete: true }
  })
  expect(store.failure('held')).toBeNull()
})

it('fences obsolete progress and final results while retaining admission until cancelled teardown', async () => {
  const store = new AgentModelCatalogStore()
  const admission = new PrioritySemaphore(1)
  const started = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const answer = Promise.withResolvers<AgentModelCatalogSuccess>()
  let notify: AgentModelCatalogProgress | undefined
  const first = store.refresh(
    'old',
    'grok',
    async (_selected, owner, publish) =>
      runAgentModelCatalogSession(
        () => ({
          close: () => {
            closing.resolve()
            return closed.promise
          }
        }),
        async () => {
          notify = publish
          publish?.(listing('usable'))
          started.resolve()
          return answer.promise
        },
        { label: 'grok', timeoutMs: null, signal: owner.signal }
      ),
    { admission }
  )
  await started.promise
  notify?.defer?.(
    () => listing('obsolete-deferred'),
    () => true
  )
  store.expireScopes('grok')
  store.flushProgress('old')
  await closing.promise
  notify?.(listing('obsolete-progress'))
  notify?.defer?.(
    () => listing('obsolete-new-deferred'),
    () => true
  )
  store.flushProgress('old')
  answer.resolve(listing('obsolete-final'))
  let entered = false
  const next = store.refresh(
    'new',
    'grok',
    async () => {
      entered = true
      return listing('new')
    },
    { admission }
  )
  await Promise.resolve()
  expect(entered).toBe(false)
  expect(store.get('old')?.models[0]?.id).toBe('usable')
  closed.resolve()
  expect(await first).toBeNull()
  expect((await next)?.models[0]?.id).toBe('new')
  expect(store.get('old')?.models[0]?.id).toBe('usable')
})

it('withdraws an abandoned queued scope while the two admitted listings continue', async () => {
  vi.useFakeTimers()
  onTestFinished(() => vi.useRealTimers())
  const h = sharedListingHarness()
  void h.service.demand({ agent: 'codex', workspacePath: '/own-a' })
  void h.service.demand({ agent: 'codex', workspacePath: '/own-b' })
  const queued = h.service.read({ agent: 'codex', workspacePath: '/own-c', waitForListing: true })
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await queued).toMatchObject({
    origin: 'unknown',
    listingInProgress: true,
    waitExpired: true
  })
  await vi.advanceTimersByTimeAsync(5_001)
  expect(
    h.service.snapshot({ agent: 'codex', workspacePath: '/own-c' }).listingInProgress
  ).toBeUndefined()
  h.listingFor('/own-a').resolve({ ...listing('a'), complete: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.service.snapshot({ agent: 'codex', workspacePath: '/own-c' }).origin).toBe('unknown')
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
