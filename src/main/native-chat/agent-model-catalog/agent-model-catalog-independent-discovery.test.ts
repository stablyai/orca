import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprintForRecord,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import { retireAtRestCommandContext } from '../agent-session-wire/at-rest-command-context'
import { structuredAgentSessionLaunchPermission } from '../agent-session-wire/structured-agent-session-launch-permission'
import { claudeAndCodexDeclared } from '../agent-session-wire/structured-agent-session-adapter-router-test-support'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const HOME = { variable: 'CLAUDE_CONFIG_DIR', path: '/account' }
const listing = (id: string, model?: string): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: [{ id, label: id, isDefault: false, efforts: [{ value: 'high', label: 'High' }] }],
  configured: model ? { model, effort: 'high' } : {}
})

function record(sessionId: string, model: string): AgentSessionRecord {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'claude',
    accountHome: HOME,
    options: { model },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    }
  })
}

function harness() {
  let now = 1000
  let installed = listing('old', 'old')
  let failure = false
  const store = new AgentModelCatalogStore({ now: () => now })
  const run = vi.fn(async () => {
    if (failure) {
      throw new Error('offline')
    }
    return installed
  })
  const resolve = vi.fn(async (_home: unknown, cwd: string) => ({
    identity: { command: 'same-cli-path', cwd },
    run
  }))
  const probe: AgentModelCatalogProbe = Object.assign(async () => run(), { resolve })
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => {
      const saved = record(id, id === 'a' ? 'old' : 'another')
      return saved ? agentSessionConversationView(saved) : undefined
    },
    getRecord: (id) => record(id, id === 'a' ? 'old' : 'another'),
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    recordWorkspacePath: async () => '/project',
    workspaceMayOverrideDefaultModel: async () => true,
    probes: { claude: probe }
  })
  return {
    store,
    service,
    resolve,
    run,
    update: (next: AgentModelCatalogSuccess) => {
      now += 120001
      installed = next
    },
    fail: () => {
      now += 120001
      failure = true
    },
    read: (sessionId = 'a', extra = {}) => service.read({ agent: 'claude', sessionId, ...extra })
  }
}

describe('independent installed CLI discovery', () => {
  it('refreshes a same-path CLI on picker demand and an old chat cannot put the old list back', async () => {
    const h = harness()
    await h.read('a', { waitForListing: true })
    h.update(listing('new', 'new'))
    void h.service.demand({ agent: 'claude', sessionId: 'a' })
    const warm = await h.read()
    expect(warm).toMatchObject({ models: [{ id: 'old' }], listingInProgress: true })
    await h.read('a', { waitForListing: true })
    h.service.recordLiveListing('a', {
      models: listing('old').models,
      configuredDefault: { modelId: 'old' }
    })
    expect(await h.read()).toMatchObject({ models: [{ id: 'new', isDefault: true }] })
    expect(h.run).toHaveBeenCalledTimes(2)
    h.fail()
    await h.read('a', { waitForListing: true })
    expect(await h.read()).toMatchObject({ models: [{ id: 'new' }] })
    expect(await h.read('a', { savedOnly: true, verifiedOnly: true })).toEqual({
      origin: 'unknown'
    })
    h.service.stop()
  })

  it('shares one scope and configured default between chats with different saved picks', async () => {
    const h = harness()
    await Promise.all([
      h.read('a', { waitForListing: true }),
      h.read('b', { waitForListing: true })
    ])
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.resolve).toHaveBeenCalledWith(
      HOME,
      '/project',
      'snapshot',
      expect.objectContaining({
        deadline: expect.any(Number),
        current: expect.any(Function),
        signal: expect.any(AbortSignal)
      })
    )
    expect(h.service.peek('a', true)).toBe(h.service.peek('b', true))
    expect(await h.read('b')).toMatchObject({
      models: [{ id: 'old', isDefault: true, defaultEffort: 'high' }]
    })
    h.service.stop()
  })

  it('discovers the project default before any chat has run and clears it when config names none', async () => {
    const h = harness()
    expect(
      await h.service.read({ agent: 'claude', workspacePath: '/project', waitForListing: true })
    ).toMatchObject({
      models: [{ id: 'old', isDefault: true }],
      listingNamesConfiguredModel: true
    })
    h.update(listing('new'))
    expect(await h.read('a', { waitForListing: true })).toMatchObject({
      models: [{ id: 'new', isDefault: false }],
      listingNamesConfiguredModel: false
    })
    expect(h.service.peek('a', true)?.configured).toBeNull()
    h.service.stop()
  })

  it('loads disk rows for display but requires completed discovery in this process as proof', async () => {
    const h = harness()
    await h.read('a', { waitForListing: true })
    const entry = h.service.peek('a', true)
    expect(entry).not.toBeNull()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence({
      load: async () => (entry ? [entry] : []),
      save: () => {},
      flush: async () => {}
    })
    expect(entry && restarted.get(entry.fingerprint)).not.toBeNull()
    expect(entry && restarted.verified(entry)).toBe(false)
    if (entry) {
      restarted.recordSuccess(
        entry.fingerprint,
        'claude',
        { ...listing('partial'), complete: false },
        'discovery'
      )
      expect(restarted.get(entry.fingerprint)).toBe(entry)
      expect(restarted.verified(entry)).toBe(false)
    }
    h.service.stop()
  })
  it('retains complete B/high whole on partial acquisition, then clears it on observed empty config', async () => {
    const h = harness()
    await h.read('a', { waitForListing: true })
    const good = h.service.peek('a')
    h.update({ ...listing('partial', 'partial'), complete: false })
    await h.read('a', { waitForListing: true })
    expect(h.service.peek('a')).toBe(good)
    expect(await h.read()).not.toHaveProperty('listingInProgress')
    expect(h.run).toHaveBeenCalledTimes(2)
    h.update(listing('new'))
    await h.read('a', { waitForListing: true })
    expect(h.service.peek('a', true)?.configured).toBeNull()
    h.service.stop()
  })

  it('paces cold unsupported display independently of proof and recovers on the same path', async () => {
    const h = harness()
    h.update({ ...listing('partial', 'partial'), complete: false })
    expect(await h.read('a', { waitForListing: true })).toMatchObject({
      models: [{ id: 'partial', isDefault: false }],
      listingNamesConfiguredModel: false
    })
    expect(h.service.peek('a', true)).toBeNull()
    await h.read()
    expect(h.run).toHaveBeenCalledTimes(1)
    h.update(listing('upgraded', 'upgraded'))
    await h.read('a', { waitForListing: true })
    expect(h.service.peek('a', true)?.models[0]?.id).toBe('upgraded')
    h.service.stop()
  })
})

it('prepares hydrated catalog evidence independently of launch permission and shares it with an equivalent chat', async () => {
  const first = record('cold-a', 'opus')
  first.permissionMode = 'auto'
  const seed = new AgentModelCatalogStore()
  const probe = Object.assign(
    vi.fn(async () => listing('opus')),
    {
      resolve: vi.fn(async () => ({
        identity: 'saved-launch',
        run: vi.fn(async () => listing('opus'))
      }))
    }
  )
  const deps = {
    getConversation: (id: string) => {
      const held = { ...first, sessionId: id }
      return held ? agentSessionConversationView(held) : undefined
    },
    getRecord: (id: string) => ({ ...first, sessionId: id }),
    drivesRecord: () => true,
    resolveAccountHome: vi.fn(async () => HOME),
    recordWorkspacePath: vi.fn(async () => '/project'),
    probes: { claude: probe }
  }
  const key = agentModelCatalogScopeFingerprint(
    agentModelCatalogFingerprintForRecord(first),
    '/project',
    'saved-launch'
  )
  const saved = seed.recordSuccess(
    key,
    'claude',
    {
      ...listing('opus'),
      models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsAutoMode: true }]
    },
    'discovery'
  )!
  const store = new AgentModelCatalogStore()
  await store.attachPersistence({
    load: async () => [saved],
    save: () => {},
    flush: async () => {}
  })
  const catalog = createAgentModelCatalogService({ ...deps, store })
  probe.resolve.mockClear()
  deps.resolveAccountHome.mockClear()
  const params = {
    agent: 'claude',
    sessionId: first.sessionId,
    inSessionWorkspace: true as const,
    savedOnly: true
  }
  expect(await catalog.read(params)).toEqual({ origin: 'unknown' })
  expect(probe.resolve).not.toHaveBeenCalled()
  expect(
    await structuredAgentSessionLaunchPermission({ agents: claudeAndCodexDeclared() }, first)
  ).toBe('auto')
  expect(probe.resolve).not.toHaveBeenCalled()
  expect(await catalog.prepareSaved(params)).toMatchObject({
    models: [{ id: 'opus', supportsAutoMode: true }]
  })
  expect(probe.resolve).toHaveBeenCalledWith(
    HOME,
    '/project',
    'saved',
    expect.objectContaining({
      current: expect.any(Function),
      signal: expect.any(AbortSignal),
      deadline: expect.any(Number)
    })
  )
  const resolutions = probe.resolve.mock.calls.length
  expect(
    await catalog.read({ ...params, workspacePath: '/project', inSessionWorkspace: undefined })
  ).toMatchObject({
    models: [{ id: 'opus', supportsAutoMode: true }]
  })
  retireAtRestCommandContext('unrelated-folder')
  expect(await catalog.read({ ...params, sessionId: 'cold-b' })).toMatchObject({
    models: [{ id: 'opus', supportsAutoMode: true }]
  })
  expect(
    await structuredAgentSessionLaunchPermission({ agents: claudeAndCodexDeclared() }, first)
  ).toBe('auto')
  expect(probe.resolve).toHaveBeenCalledTimes(resolutions)
  expect(probe).not.toHaveBeenCalled()
  expect(deps.resolveAccountHome).not.toHaveBeenCalled()
  catalog.stop()
})
