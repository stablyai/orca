import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
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
    run,
    resolve,
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
    expect(h.resolve.mock.calls.every((call) => call.length === 2)).toBe(true)
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
