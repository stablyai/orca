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
  // Folders under /busy and /own each resolve their own CLI; every other folder shares one listing.
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
        // Busy CLIs are slow to stop: they hold their slot until they finish.
        if (!identity.startsWith('/busy')) {
          signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
        }
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
          const identity =
            folder?.startsWith('/busy') || folder?.startsWith('/own') ? folder : 'codex'
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
  const started = Date.now()
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
  // Its requests carry the refresh's own budget, not the first reader's deadline.
  expect(h.runs[0]?.deadline).toBe(started + 30_000)
  h.discovery.resolve({ ...listing('shared'), complete: true, configured: {} })
  await vi.advanceTimersByTimeAsync(0)
  expect(await b).toMatchObject({ models: [{ id: 'shared' }] })
  expect(h.run).toHaveBeenCalledOnce()
})

it.each(['retired', 'stopped'] as const)(
  'stops a shared listing and drops its late answer when the account is %s',
  async (how) => {
    const h = sharedListingHarness()
    void h.service.demand({ agent: 'codex', workspacePath: '/a' })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
    const write = vi.spyOn(h.store, 'recordSuccess')
    if (how === 'retired') {
      h.store.expireAgent('codex')
    } else {
      await h.service.stop()
    }
    expect(h.runs[0]?.signal?.aborted).toBe(true)
    expect(h.runs[0]?.current?.()).toBe(false)
    h.discovery.resolve(listing('late'))
    await expect(h.run.mock.results[0]?.value).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
  }
)

it('never starts a queued shared listing once its budget has run out, nor a replacement', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  // Two other CLIs hold both discovery slots past every budget below.
  for (const busy of ['/busy-1', '/busy-2']) {
    void h.service.demand({ agent: 'codex', workspacePath: busy })
  }
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
  void h.service.demand({ agent: 'codex', workspacePath: '/a', deadline: Date.now() + 1_000 })
  void h.service.demand({ agent: 'codex', workspacePath: '/b', deadline: Date.now() + 2_000 })
  await vi.advanceTimersByTimeAsync(31_000)
  h.listingFor('/busy-1').resolve(listing('busy'))
  h.listingFor('/busy-2').resolve(listing('busy'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.runs.map((entry) => entry.identity)).toEqual(['/busy-1', '/busy-2'])
})

it.each([5, 50])(
  'runs two of %i folders with their own CLIs at a time, starts none after its budget, and leaves nothing behind',
  async (folders) => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const h = sharedListingHarness()
    for (let index = 0; index < folders; index++) {
      void h.service.demand({ agent: 'codex', workspacePath: `/own-${index}` })
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(h.run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.runs.every((entry) => entry.signal?.aborted)).toBe(true)
    // No reader asked again, so nothing replaces the expired work.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.run).toHaveBeenCalledTimes(2)
    for (let index = 0; index < folders; index++) {
      expect(
        h.service.snapshot({ agent: 'codex', workspacePath: `/own-${index}` })
      ).not.toHaveProperty('listingInProgress')
    }
  }
)

it('keeps a queued shared listing for a folder that still wants it after the first gave up', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  for (const busy of ['/busy-1', '/busy-2']) {
    void h.service.demand({ agent: 'codex', workspacePath: busy })
  }
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
  void h.service.demand({ agent: 'codex', workspacePath: '/a', deadline: Date.now() + 1_000 })
  const b = h.service.read({
    agent: 'codex',
    workspacePath: '/b',
    waitForListing: true,
    deadline: Date.now() + 60_000
  })
  await vi.advanceTimersByTimeAsync(2_000)
  h.listingFor('/busy-1').resolve(listing('busy'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.runs.map((entry) => entry.identity)).toEqual(['/busy-1', '/busy-2', 'codex'])
  h.discovery.resolve({ ...listing('shared'), complete: true, configured: {} })
  await vi.advanceTimersByTimeAsync(0)
  expect(await b).toMatchObject({ models: [{ id: 'shared' }] })
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

it('keeps a later reader of the same folder waiting for its own deadline, not the first one', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  void h.service.demand({ agent: 'codex', workspacePath: '/a', deadline: Date.now() + 1_000 })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  const later = h.service.read({
    agent: 'codex',
    workspacePath: '/a',
    waitForListing: true,
    deadline: Date.now() + 60_000
  })
  await vi.advanceTimersByTimeAsync(2_000)
  h.discovery.resolve({ ...listing('shared'), complete: true, configured: {} })
  await vi.advanceTimersByTimeAsync(0)
  expect(await later).toMatchObject({ models: [{ id: 'shared' }] })
  expect(h.run).toHaveBeenCalledOnce()
})

function readOperation(h: ReturnType<typeof sharedListingHarness>, deadline: number) {
  const controller = new AbortController()
  let current = true
  return {
    operation: {
      deadline,
      retirement: h.store.retirementRevision('codex'),
      signal: controller.signal,
      controller,
      current: () => current && !controller.signal.aborted && Date.now() < deadline
    },
    // As when its chat closes: its own request no longer matches, though nothing aborts it.
    leave: () => {
      current = false
    }
  }
}

it("keeps a shared listing for a second chat when the first chat's own request stops matching", async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  const first = readOperation(h, Date.now() + 60_000)
  void h.service.demand({ agent: 'codex', workspacePath: '/a', operation: first.operation })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  const second = h.service.read({
    agent: 'codex',
    workspacePath: '/a',
    waitForListing: true,
    deadline: Date.now() + 30_000
  })
  await vi.advanceTimersByTimeAsync(0)
  first.leave()
  await vi.advanceTimersByTimeAsync(1_000)
  h.discovery.resolve({ ...listing('shared'), complete: true, configured: {} })
  await vi.advanceTimersByTimeAsync(0)
  expect(await second).toMatchObject({ models: [{ id: 'shared' }] })
  expect(h.run).toHaveBeenCalledOnce()
})

it('settles each reader at its own deadline or cancellation, and stops the listing only at its budget', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  let settled = false
  void h.service
    .demand({ agent: 'codex', workspacePath: '/a', deadline: Date.now() + 1_000 })
    .then(() => {
      settled = true
    })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  const longer = readOperation(h, Date.now() + 30_000)
  void h.service.demand({ agent: 'codex', workspacePath: '/a', operation: longer.operation })
  longer.operation.controller.abort()
  await vi.advanceTimersByTimeAsync(1_500)
  expect(settled).toBe(true)
  // Nobody waits any more, but the listing belongs to its refresh, not to them.
  expect(h.runs[0]?.signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(28_500)
  expect(h.runs[0]?.signal?.aborted).toBe(true)
  h.discovery.resolve({ ...listing('late'), complete: true, configured: {} })
  await vi.advanceTimersByTimeAsync(0)
  // Its late answer is dropped.
  expect(h.service.snapshot({ agent: 'codex', workspacePath: '/a' }).origin).toBe('unknown')
})
