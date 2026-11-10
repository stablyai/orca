import { expect, it, onTestFinished, vi } from 'vitest'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../structured-agent-command-resolution'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'
import type { AgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe'
  }
}

function discover(
  service: ReturnType<typeof createAgentModelCatalogService>,
  params: Parameters<typeof service.read>[0]
) {
  void service.demand(params)
  return service.read(params)
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

it('keeps a queued listing only while a refresh or reader still waits on it', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  // Two other CLIs hold both discovery slots.
  for (const busy of ['/busy-1', '/busy-2']) {
    void h.service.demand({ agent: 'codex', workspacePath: busy })
  }
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
  void h.service.demand({ agent: 'codex', workspacePath: '/own-dropped' })
  void h.service.demand({ agent: 'codex', workspacePath: '/own-waited' })
  await vi.advanceTimersByTimeAsync(25_000)
  void h.service.read({ agent: 'codex', workspacePath: '/own-waited', waitForListing: true })
  await vi.advanceTimersByTimeAsync(15_000)
  h.listingFor('/busy-1').resolve(listing('busy'))
  h.listingFor('/busy-2').resolve(listing('busy'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.runs.map((entry) => entry.identity)).toEqual(['/busy-1', '/busy-2', '/own-waited'])
})

it('retires queued discovery before shutdown releases an admission slot', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  for (const workspacePath of ['/busy-1', '/busy-2', '/own-queued']) {
    void h.service.demand({ agent: 'codex', workspacePath })
  }
  await vi.advanceTimersByTimeAsync(0)
  expect(h.service.snapshot({ agent: 'codex', workspacePath: '/own-queued' })).toMatchObject({
    listingInProgress: true
  })

  const stopped = h.service.stop()
  h.listingFor('/busy-1').resolve(listing('busy'))
  h.listingFor('/busy-2').resolve(listing('busy'))
  await vi.advanceTimersByTimeAsync(0)
  await stopped

  expect(h.runs.map((entry) => entry.identity)).toEqual(['/busy-1', '/busy-2'])
})

it('reports an expired captured wait and lets the next reader finish its queued listing', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = sharedListingHarness()
  for (const workspacePath of ['/busy-1', '/busy-2']) {
    void h.service.demand({ agent: 'codex', workspacePath })
  }
  await vi.advanceTimersByTimeAsync(0)
  const params = { agent: 'codex', workspacePath: '/own-waited', waitForListing: true }
  const operation = h.service.captureRead(params)
  const request = { ...params, operation, deadline: operation.deadline }
  const first = h.service.read(request)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await first).toEqual({ origin: 'unknown', listingInProgress: true, waitExpired: true })

  operation.controller.abort()
  expect(await h.service.read(request)).toEqual({ origin: 'unknown' })

  const next = h.service.read(params)
  await vi.advanceTimersByTimeAsync(0)
  h.listingFor('/busy-1').resolve(listing('busy'))
  h.listingFor('/own-waited').resolve(listing('fresh'))
  await vi.advanceTimersByTimeAsync(0)
  expect(await next).toMatchObject({ origin: 'probe', models: [{ id: 'fresh' }] })
  expect(await next).not.toHaveProperty('waitExpired')
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

it('publishes cached catalogs immediately and completes queued discoveries after admission', async () => {
  vi.useFakeTimers()
  const store = new AgentModelCatalogStore()
  let warming = true
  const probe =
    (agent: string) => (_home: AgentSessionAccountHome, options?: { signal?: AbortSignal }) =>
      new Promise<AgentModelCatalogSuccess>((resolve, reject) => {
        // ast-grep-ignore: test-no-real-time-wait -- Fake timers simulate probe execution after queued admission.
        const timer = setTimeout(
          () =>
            resolve({
              ...listing(warming ? 'saved' : `${agent}-fresh`),
              complete: true,
              configured: {}
            }),
          agent === 'pi' || agent === 'gemini' ? 20_000 : 15_000
        )
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('stopped'))
          },
          { once: true }
        )
      })
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: '/account' }),
    probes: {
      pi: probe('pi'),
      gemini: probe('gemini'),
      claude: probe('claude'),
      codex: probe('codex')
    }
  })
  try {
    const saved = service.read({ agent: 'claude', waitForListing: true })
    await vi.advanceTimersByTimeAsync(15_000)
    await saved
    warming = false
    await vi.advanceTimersByTimeAsync(120_001)

    for (const agent of ['pi', 'gemini', 'claude', 'codex']) {
      await discover(service, { agent })
    }
    expect(await service.read({ agent: 'claude' })).toMatchObject({
      models: [{ id: 'saved' }],
      listingInProgress: true
    })

    const expired = service.read({
      agent: 'claude',
      waitForListing: true,
      deadline: Date.now() + 5_000
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await expired).toMatchObject({
      models: [{ id: 'saved' }],
      listingInProgress: true,
      waitExpired: true
    })

    await vi.advanceTimersByTimeAsync(15_000)
    const warm = service.read({ agent: 'claude', waitForListing: true })
    const cold = service.read({ agent: 'codex', waitForListing: true })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await warm).toMatchObject({ models: [{ id: 'claude-fresh' }] })
    expect(await cold).toMatchObject({ models: [{ id: 'codex-fresh' }] })
    const account = agentModelCatalogFingerprint({
      agent: 'claude',
      accountHome: { variable: 'CODEX_HOME', path: '/account' },
      wslDistro: null
    })
    expect(store.observation(account)).toMatchObject({
      models: [{ id: 'claude-fresh', isDefault: false }]
    })
  } finally {
    await service.stop()
    vi.useRealTimers()
  }
})
