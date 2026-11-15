import { expect, it, onTestFinished, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'

const HOME = { variable: 'CODEX_HOME', path: '/account' }
// Its picker follows a project's own settings, unlike Claude's and Codex's.
const agent = 'pi'

function chat(sessionId: string, workspaceId = 'ws', provider = 'codex'): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    provider,
    accountHome: HOME,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind: 'folder'
    }
  })
}

const listing = (id: string): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  configured: {},
  models: [{ id, label: id, isDefault: true, efforts: [] }]
})

// Chats a and b share one workspace, so they share one request. The next folder lookup, CLI
// resolution or project-settings check can each be held once. Claude and Codex never check a
// project's settings, so settings stages run as Pi.
function harness(agent = 'codex') {
  const records: Record<string, AgentSessionRecord> = {
    a: chat('a', 'ws', agent),
    b: chat('b', 'ws', agent)
  }
  const folder: {
    path: string
    gate?: PromiseWithResolvers<void>
    cli?: PromiseWithResolvers<void>
    settings?: PromiseWithResolvers<void>
  } = { path: '/ws' }
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
  const recordWorkspacePath = vi.fn(async (_row: { location: { workspaceId: string } }) => {
    const path = folder.path
    await once('gate')
    return path
  })
  const workspaceMayOverrideDefaultModel = vi.fn(async (_input: { workspacePath: string }) => {
    await once('settings')
    return false
  })
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => (records[id] ? agentSessionConversationView(records[id]) : undefined),
    getRecord: (id) => records[id],
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    recordWorkspacePath,
    agentReadsProjectModelConfig: () => true,
    workspaceMayOverrideDefaultModel,
    // Claude and Codex list through their resolved CLI; other agents through the probe itself.
    probes: {
      [agent]: Object.assign(
        vi.fn((_home: unknown, options?: { signal?: AbortSignal }) => run(options?.signal)),
        { resolve: agent === 'codex' ? resolve : undefined }
      )
    }
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
    store,
    service
  }
}

it('keeps one listing for a workspace on the same folder when another workspace there moves', async () => {
  const h = harness()
  h.records.a = chat('a', 'ws-a')
  h.records.b = chat('b', 'ws-b')
  const paths: Record<string, string> = { 'ws-a': '/repo', 'ws-b': '/repo' }
  h.recordWorkspacePath.mockImplementation(async (row) => paths[row.location.workspaceId]!)
  // A command line that runs in the chat's folder lists there, once per folder.
  const lists: Record<string, PromiseWithResolvers<AgentModelCatalogSuccess>> = {
    '/repo': Promise.withResolvers(),
    '/other': Promise.withResolvers()
  }
  const runs: string[] = []
  h.resolve.mockImplementation(async (_home, _cwd, _lookup, _operation, at) => ({
    identity: `codex in ${at}`,
    run: vi.fn(() => {
      runs.push(at!)
      return lists[at!]!.promise
    })
  }))
  void h.service.demand({ agent: 'codex', sessionId: 'a' })
  await vi.waitFor(() => expect(runs).toEqual(['/repo']))
  const b = h.service.read({ agent: 'codex', sessionId: 'b', waitForListing: true })
  paths['ws-a'] = '/other'
  h.service.retireContext('ws-a')
  const a = h.service.read({ agent: 'codex', sessionId: 'a', waitForListing: true })
  await vi.waitFor(() => expect(runs).toEqual(['/repo', '/other']))
  lists['/repo']!.resolve(listing('repo'))
  expect(await b).toMatchObject({ models: [{ id: 'repo' }] })
  lists['/other']!.resolve(listing('other'))
  expect(await a).toMatchObject({ models: [{ id: 'other' }] })
})

it('ends a shorter reader while scope resolution remains current', async () => {
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
  // Its readers are gone, but the refresh runs on its own budget.
  expect(h.service.snapshot({ agent: 'codex', sessionId: 'b' })).toHaveProperty('listingInProgress')
  await vi.advanceTimersByTimeAsync(29_000)
  expect(h.service.snapshot({ agent: 'codex', sessionId: 'b' })).toHaveProperty('listingInProgress')
  gate.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.run).not.toHaveBeenCalled()
})

it('holds readers of a stalled refresh only to their own deadlines, and starts no other until asked', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = harness()
  const gate = Promise.withResolvers<void>()
  h.folder.gate = gate
  void h.service.demand({ agent: 'codex', sessionId: 'a', deadline: Date.now() + 1_000 })
  const b = h.service.read({
    agent: 'codex',
    sessionId: 'b',
    waitForListing: true,
    deadline: Date.now() + 30_000
  })
  await vi.advanceTimersByTimeAsync(30_000)
  // b's deadline ended its wait; a reader leaving never restarts the work.
  expect(await b).toMatchObject({ origin: 'unknown', listingInProgress: true, waitExpired: true })
  expect(h.recordWorkspacePath).toHaveBeenCalledOnce()
  const c = h.service.read({
    agent: 'codex',
    sessionId: 'b',
    waitForListing: true,
    deadline: Date.now() + 30_000
  })
  await vi.advanceTimersByTimeAsync(15_000)
  gate.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.recordWorkspacePath).toHaveBeenCalledOnce()
  h.discovery.resolve(listing('fresh'))
  await vi.advanceTimersByTimeAsync(0)
  expect(await c).toMatchObject({ models: [{ id: 'fresh' }] })
})

it("keeps the folder's defaults when they arrive after a shorter last reader left", async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = harness(agent)
  h.folder.settings = Promise.withResolvers<void>()
  const settings = h.folder.settings
  const a = h.service.read({
    agent,
    sessionId: 'a',
    waitForListing: true,
    deadline: Date.now() + 30_000
  })
  void h.service.demand({ agent, sessionId: 'b', deadline: Date.now() + 1_000 })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(2_000)
  settings.resolve()
  h.discovery.resolve(listing('listed'))
  await vi.advanceTimersByTimeAsync(0)
  // The project picks nothing, so the account's default stands.
  expect(await a).toMatchObject({ models: [{ id: 'listed', isDefault: true }] })
})

it('delivers inventory before slow folder defaults, then delivers the proven default', async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = harness(agent)
  const settings = Promise.withResolvers<void>()
  h.folder.settings = settings
  const first = h.service.read({ agent, sessionId: 'b', waitForListing: true })
  await vi.advanceTimersByTimeAsync(0)
  h.discovery.resolve(listing('listed'))
  await vi.advanceTimersByTimeAsync(0)
  expect(await first).toMatchObject({
    models: [{ id: 'listed', isDefault: false }],
    listingInProgress: true
  })
  let next: unknown
  const follow = h.service.read({ agent, sessionId: 'b', waitForListing: true }).then((result) => {
    next = result
  })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(next).toBeUndefined()
  settings.resolve()
  await follow
  expect(next).toMatchObject({ models: [{ id: 'listed', isDefault: true }] })
  expect(next).not.toHaveProperty('listingInProgress')
})

it("never lets a moved folder's late settings describe the folder it moved to", async () => {
  vi.useFakeTimers()
  onTestFinished(() => {
    vi.useRealTimers()
  })
  const h = harness(agent)
  const stalled = Promise.withResolvers<void>()
  // The old folder's settings pick their own model; the new folder's pick nothing.
  h.workspaceMayOverrideDefaultModel.mockImplementation(async (input) => {
    const old = input.workspacePath === '/ws'
    if (old) {
      await stalled.promise
    }
    return old
  })
  void h.service.demand({ agent, sessionId: 'b' })
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledOnce())
  h.folder.path = '/new'
  h.service.retireContext('ws')
  const moved = h.service.read({ agent, sessionId: 'b', waitForListing: true })
  h.discovery.resolve(listing('listed'))
  expect(await moved).toMatchObject({ models: [{ id: 'listed', isDefault: true }] })
  stalled.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.service.snapshot({ agent, sessionId: 'b' })).toMatchObject({
    models: [{ id: 'listed', isDefault: true }]
  })
})

it('keeps one folder-agent listing for a workspace on the same folder when another workspace there moves', async () => {
  const records = new Map(
    ['a', 'b'].map((id) => [id, { ...chat(id, `ws-${id}`), provider: 'opencode' }])
  )
  const paths: Record<string, string> = { 'ws-a': '/repo', 'ws-b': '/repo' }
  const lists: Record<string, PromiseWithResolvers<AgentModelCatalogSuccess>> = {
    '/repo': Promise.withResolvers(),
    '/other': Promise.withResolvers()
  }
  const probe = vi.fn((_home: unknown, options?: { workspacePath?: string }) => {
    return lists[options!.workspacePath!]!.promise
  })
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: (id) => {
      const held = records.get(id)
      return held ? agentSessionConversationView(held) : undefined
    },
    getRecord: (id) => records.get(id),
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    recordWorkspacePath: async (row) => paths[row.location.workspaceId]!,
    listsInChatFolder: new Set(['opencode']),
    probes: { opencode: probe }
  })
  onTestFinished(() => {
    lists['/repo']!.resolve(listing('late'))
    lists['/other']!.resolve(listing('late'))
    return service.stop()
  })
  const params = (sessionId: string) => ({
    agent: 'opencode',
    sessionId,
    inSessionWorkspace: true as const,
    waitForListing: true
  })
  void service.demand(params('a'))
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
  const b = service.read(params('b'))
  paths['ws-a'] = '/other'
  service.retireContext('ws-a')
  const a = service.read(params('a'))
  await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
  lists['/repo']!.resolve(listing('repo'))
  expect(await b).toMatchObject({ models: [{ id: 'repo' }] })
  lists['/other']!.resolve(listing('other'))
  expect(await a).toMatchObject({ models: [{ id: 'other' }] })
  expect(probe.mock.calls.map((call) => call[1]?.workspacePath)).toEqual(['/repo', '/other'])
})
