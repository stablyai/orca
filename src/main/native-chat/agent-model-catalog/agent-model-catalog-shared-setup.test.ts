import { expect, it, onTestFinished, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'

const HOME = { variable: 'CODEX_HOME', path: '/account' }

function chat(sessionId: string): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: HOME,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws',
      workspaceKind: 'folder'
    }
  })
}

/** As when its tab closes: the owner is released with evidence that its process ended. */
function released(record: AgentSessionRecord): AgentSessionRecord {
  return {
    ...record,
    lease: {
      ...record.lease,
      claimStatus: 'released',
      deathEvidence: {
        kind: 'kill-delivered',
        detail: 'closed',
        observedAt: 2_000,
        ownerFence: record.lease.runtimeFence,
        lastProvenAliveAt: 1_000,
        runtimeEnd: 'quit'
      }
    }
  }
}

const listing = (id: string): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  configured: {},
  models: [{ id, label: id, isDefault: true, efforts: [] }]
})

// Chats a and b share one workspace, so they share one request. The next folder lookup, CLI
// resolution or project-settings check can each be held once.
function harness() {
  const records: Record<string, AgentSessionRecord> = { a: chat('a'), b: chat('b') }
  const folder = {
    path: '/ws',
    gate: undefined as PromiseWithResolvers<void> | undefined,
    cli: undefined as PromiseWithResolvers<void> | undefined,
    settings: undefined as PromiseWithResolvers<void> | undefined
  }
  const once = async (name: 'gate' | 'cli' | 'settings') => {
    const held = folder[name]
    folder[name] = undefined
    await held?.promise
  }
  const discovery = Promise.withResolvers<AgentModelCatalogSuccess>()
  const run = vi.fn((signal?: AbortSignal) => {
    signal?.addEventListener('abort', () => discovery.reject(new Error('stopped')), { once: true })
    return discovery.promise
  })
  const resolve = vi.fn(
    async (_home: unknown, _cwd: string, _lookup: unknown, _operation: unknown, at?: string) => {
      await once('cli')
      return { identity: `codex in ${at}`, run }
    }
  )
  const recordWorkspacePath = vi.fn(async () => {
    const path = folder.path
    await once('gate')
    return path
  })
  const workspaceMayOverrideDefaultModel = vi.fn(async () => {
    await once('settings')
    return false
  })
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: (id) => (records[id] ? agentSessionConversationView(records[id]) : undefined),
    getRecord: (id) => records[id],
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    recordWorkspacePath,
    workspaceMayOverrideDefaultModel,
    probes: { codex: Object.assign(vi.fn(), { resolve }) }
  })
  onTestFinished(() => {
    discovery.resolve(listing('late'))
    return service.stop()
  })
  return {
    records,
    folder,
    discovery,
    run,
    resolve,
    recordWorkspacePath,
    workspaceMayOverrideDefaultModel,
    service
  }
}

it.each(['listing', 'setup'] as const)(
  "keeps chat b's listing when chat a closes during its %s and an unrelated folder changes",
  async (stage) => {
    const h = harness()
    if (stage === 'setup') {
      h.folder.gate = Promise.withResolvers<void>()
    }
    void h.service.demand({ agent: 'codex', sessionId: 'a', deadline: Date.now() + 60_000 })
    const b = h.service.read({
      agent: 'codex',
      sessionId: 'b',
      waitForListing: true,
      deadline: Date.now() + 30_000
    })
    if (stage === 'listing') {
      await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
    }
    h.records.a = released(h.records.a)
    h.service.retireContext('another-folder')
    h.folder.gate?.resolve()
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
    h.discovery.resolve(listing('shared'))
    expect(await b).toMatchObject({ models: [{ id: 'shared' }] })
    expect(h.run).toHaveBeenCalledOnce()
  }
)

it('ends a shorter reader at its own deadline, and a setup nobody waits for lists nothing', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = harness()
  const gate = Promise.withResolvers<void>()
  h.folder.gate = gate
  const longer = h.service.captureRead({
    agent: 'codex',
    sessionId: 'a',
    deadline: Date.now() + 30_000
  })
  void h.service.demand({ agent: 'codex', sessionId: 'a', operation: longer })
  let settled = false
  void h.service
    .demand({ agent: 'codex', sessionId: 'b', deadline: Date.now() + 1_000 })
    .then(() => {
      settled = true
    })
  longer.controller.abort()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(settled).toBe(true)
  expect(h.service.snapshot({ agent: 'codex', sessionId: 'b' })).not.toHaveProperty(
    'listingInProgress'
  )
  gate.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.run).not.toHaveBeenCalled()
})

it.each([10, 100])(
  'resolves setup and project settings once for %i readers of one request, before and after it settles',
  async (readers) => {
    const h = harness()
    const gate = Promise.withResolvers<void>()
    h.folder.gate = gate
    const reads = Array.from({ length: readers }, () =>
      h.service.demand({ agent: 'codex', sessionId: 'b', deadline: Date.now() + 30_000 })
    )
    gate.resolve()
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
    // More readers arrive while the listing that setup found is still running.
    reads.push(
      ...Array.from({ length: readers }, () =>
        h.service.demand({ agent: 'codex', sessionId: 'b', deadline: Date.now() + 30_000 })
      )
    )
    h.discovery.resolve(listing('shared'))
    await Promise.all(reads)
    // One request needs one folder lookup, one CLI resolution and one project-settings check.
    expect(h.recordWorkspacePath).toHaveBeenCalledOnce()
    // A due listing resolves the CLI twice (a snapshot, then a fresh lookup), once per setup.
    expect(h.resolve.mock.calls.length).toBeLessThanOrEqual(2)
    expect(h.workspaceMayOverrideDefaultModel.mock.calls.length).toBeLessThanOrEqual(1)
    expect(h.run).toHaveBeenCalledOnce()
  }
)

it('lets a reader with time left start a fresh setup when a stalled one runs out', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = harness()
  h.folder.gate = Promise.withResolvers<void>()
  void h.service.demand({ agent: 'codex', sessionId: 'a', deadline: Date.now() + 1_000 })
  const b = h.service.read({
    agent: 'codex',
    sessionId: 'b',
    waitForListing: true,
    deadline: Date.now() + 30_000
  })
  await vi.advanceTimersByTimeAsync(1_000)
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  expect(h.recordWorkspacePath).toHaveBeenCalledTimes(2)
  h.discovery.resolve(listing('fresh'))
  await vi.advanceTimersByTimeAsync(0)
  expect(await b).toMatchObject({ models: [{ id: 'fresh' }] })
})

it("resolves a moved folder afresh instead of reusing the old folder's setup", async () => {
  const h = harness()
  h.folder.cli = Promise.withResolvers<void>()
  void h.service.demand({ agent: 'codex', sessionId: 'b' })
  await vi.waitFor(() => expect(h.resolve).toHaveBeenCalledOnce())
  h.folder.path = '/new'
  h.service.retireContext('ws')
  void h.service.demand({ agent: 'codex', sessionId: 'b' })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  expect(h.resolve.mock.calls.at(-1)?.[4]).toBe('/new')
})

it.each(['cancelled', 'stopped'] as const)(
  'settles a reader at once when it is %s while its setup is stalled',
  async (how) => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const h = harness()
    h.folder.gate = Promise.withResolvers<void>()
    const reader = h.service.captureRead({
      agent: 'codex',
      sessionId: 'b',
      deadline: Date.now() + 30_000
    })
    let settled = false
    void h.service.demand({ agent: 'codex', sessionId: 'b', operation: reader }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(0)
    if (how === 'cancelled') {
      reader.controller.abort()
    } else {
      void h.service.stop()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(true)
  }
)

it("keeps the folder's defaults when they arrive after a shorter last reader left", async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = harness()
  h.folder.settings = Promise.withResolvers<void>()
  const settings = h.folder.settings
  const a = h.service.read({
    agent: 'codex',
    sessionId: 'a',
    waitForListing: true,
    deadline: Date.now() + 30_000
  })
  void h.service.demand({ agent: 'codex', sessionId: 'b', deadline: Date.now() + 1_000 })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(2_000)
  settings.resolve()
  h.discovery.resolve(listing('listed'))
  await vi.advanceTimersByTimeAsync(0)
  // The project picks nothing, so the account's default stands.
  expect(await a).toMatchObject({ models: [{ id: 'listed', isDefault: true }] })
})
