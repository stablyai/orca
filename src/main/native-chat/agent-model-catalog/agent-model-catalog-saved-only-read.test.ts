import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'
import { agentReadsProjectModelConfig } from './agent-project-model-override'

const HOME = { variable: 'GROK_HOME', path: '/homes/grok' } as const
const FINGERPRINT = agentModelCatalogFingerprint({
  agent: 'grok',
  accountHome: HOME,
  wslDistro: null
})
const SIGNED_OUT = { reason: 'notSignedIn', account: 'system' } as const

it('keeps a released claim separate while two eligible chats share their first project listing', async () => {
  const released = {
    ...agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: 'released',
        claimStatus: 'released',
        ownerProcess: null,
        deathEvidence: {
          kind: 'pid-absent',
          detail: 'failed before spawn',
          observedAt: 1000,
          ownerFence: 7
        }
      })
    ),
    provider: 'opencode',
    accountHome: { kind: 'opencode' as const, locator: { kind: 'unmanaged' as const } },
    providerHandleChain: []
  }
  const liveA = {
    ...released,
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'live-a' })),
    provider: released.provider,
    accountHome: released.accountHome,
    providerHandleChain: []
  }
  const liveB = {
    ...liveA,
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'live-b' })),
    provider: released.provider,
    accountHome: released.accountHome,
    providerHandleChain: []
  }
  const records = new Map([released, liveA, liveB].map((record) => [record.sessionId, record]))
  const folder = Promise.withResolvers<string>()
  const answer = Promise.withResolvers<AgentModelCatalogSuccess>()
  const probe = vi.fn(() => answer.promise)
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: (id) => {
      const held = records.get(id)
      return held ? agentSessionConversationView(held) : undefined
    },
    getRecord: (id) => records.get(id),
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    recordWorkspacePath: async () => folder.promise,
    listsInChatFolder: new Set(['opencode']),
    probes: { opencode: probe }
  })
  const request = (sessionId: string) => ({
    agent: 'opencode',
    sessionId,
    inSessionWorkspace: true as const
  })
  try {
    const first = service.demand(request(released.sessionId))
    const eligible = service.demand(request(liveA.sessionId))
    const joined = service.demand(request(liveB.sessionId))
    expect(first).not.toBe(eligible)
    expect(joined).toBe(eligible)
    folder.resolve('/project')
    await first
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    answer.resolve(listing('project-model'))
    await Promise.all([eligible, joined])
    expect(service.snapshot(request(liveA.sessionId))).toMatchObject({
      models: [{ id: 'project-model' }]
    })
    expect(service.snapshot(request(liveB.sessionId))).toMatchObject({
      models: [{ id: 'project-model' }]
    })
    await service.demand(request(released.sessionId))
    expect(probe).toHaveBeenCalledOnce()
  } finally {
    answer.resolve(listing('project-model'))
    folder.resolve('/project')
    service.stop()
  }
})

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe'
  }
}

function rig(agent = 'grok') {
  let now = 1_000
  const store = new AgentModelCatalogStore({ now: () => now })
  const probe = vi.fn(
    (_home: AgentSessionAccountHome) => new Promise<AgentModelCatalogSuccess>(() => {})
  )
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    probes: { [agent]: probe },
    listingNamesConfiguredModel: new Set(['grok']),
    agentReadsProjectModelConfig
  })
  return { store, probe, service, advance: (ms: number) => (now += ms) }
}

describe('a saved-only catalog read', () => {
  it('does not relaunch a released chat to read models after startup failed', async () => {
    let now = 1_000
    const record = {
      ...agentSessionRecordFixture(
        agentSessionLeaseFixture({
          claimStatus: 'released',
          ownerProcess: null,
          deathEvidence: {
            kind: 'pid-absent',
            detail: 'reservation failed before spawn',
            observedAt: now,
            ownerFence: 6
          }
        })
      ),
      provider: 'grok',
      accountHome: HOME
    }
    const store = new AgentModelCatalogStore({ now: () => now })
    const probe = vi.fn(async () => listing('grok-4.7'))
    const resolveAccountHome = vi.fn(async () => HOME)
    const service = createAgentModelCatalogService({
      store,
      getConversation: (sessionId) => {
        const saved = sessionId === record.sessionId ? record : undefined
        return saved ? agentSessionConversationView(saved) : undefined
      },
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome,
      probes: { grok: probe }
    })

    expect(
      await service.read({ agent: 'grok', sessionId: record.sessionId, waitForListing: true })
    ).toEqual({
      origin: 'unknown'
    })
    expect(probe).not.toHaveBeenCalled()

    store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    now += AGENT_MODEL_CATALOG_FRESH_MS
    expect(await service.read({ agent: 'grok', sessionId: record.sessionId })).toMatchObject({
      origin: 'probe',
      models: [{ id: 'grok-4.7' }]
    })
    expect(probe).not.toHaveBeenCalled()

    expect(resolveAccountHome).not.toHaveBeenCalled()
    await service.read({ agent: 'grok', waitForListing: true })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('answers from the saved entry and starts nothing, however old the entry is', async () => {
    const { store, probe, service, advance } = rig()
    store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    await service.demand({ agent: 'grok' })
    advance(AGENT_MODEL_CATALOG_FRESH_MS)
    const result = await service.read({ agent: 'grok', savedOnly: true })
    expect(result).toMatchObject({ origin: 'probe', models: [{ id: 'grok-4.7' }] })
    expect(result).not.toHaveProperty('listingInProgress')
    expect(store.pendingListing(FINGERPRINT)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    // The same read without `savedOnly` refreshes the aged entry: the probe is what the flag skips.
    await service.read({ agent: 'grok', waitForListing: true })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
  })

  it('answers unknown with nothing saved, and starts no listing for it', async () => {
    const { store, probe, service } = rig()
    expect(await service.read({ agent: 'grok', savedOnly: true })).toEqual({ origin: 'unknown' })
    expect(store.pendingListing(FINGERPRINT)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('carries a held reason without re-checking it past its TTL', async () => {
    const { store, probe, service, advance } = rig()
    await store
      .refresh(FINGERPRINT, 'grok', () =>
        Promise.reject(new AgentModelCatalogUnavailableError(SIGNED_OUT))
      )
      .catch(() => undefined)
    await service.demand({ agent: 'grok' })
    advance(AGENT_MODEL_CATALOG_FAILURE_TTL_MS)
    expect(await service.read({ agent: 'grok', savedOnly: true })).toEqual({
      origin: 'unknown',
      unavailable: SIGNED_OUT
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('says the named default holds in every workspace only for an agent no project config moves', async () => {
    const grok = rig('grok')
    grok.store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    await grok.service.demand({ agent: 'grok' })
    expect(await grok.service.read({ agent: 'grok', savedOnly: true })).toMatchObject({
      listingNamesConfiguredModel: true,
      defaultHoldsInEveryWorkspace: true
    })
    // Project config can pick OpenCode's default even when model listings name none.
    const opencode = rig('opencode')
    const opencodeKey = agentModelCatalogFingerprint({
      agent: 'opencode',
      accountHome: HOME,
      wslDistro: null
    })
    opencode.store.recordSuccess(opencodeKey, 'opencode', listing('a/b'), 'discovery')
    await opencode.service.demand({ agent: 'opencode' })
    expect(await opencode.service.read({ agent: 'opencode', savedOnly: true })).not.toHaveProperty(
      'defaultHoldsInEveryWorkspace'
    )
  })
})

it('returns a snapshot before a cold worktree selector resolves', async () => {
  const folder = Promise.withResolvers<string | null>()
  const account = vi.fn(async () => HOME)
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: account
  })
  const request = {
    agent: 'grok',
    workspace: {
      selector: 'folder',
      identity: () => 1,
      resolve: () => folder.promise
    }
  }
  try {
    expect(await service.read(request)).toEqual({ origin: 'unknown' })
    expect(account).not.toHaveBeenCalled()
    void service.demand(request)
    expect(await service.read(request)).toEqual({ origin: 'unknown', listingInProgress: true })
    expect(await service.read({ ...request, savedOnly: true })).toEqual({ origin: 'unknown' })
    expect(account).not.toHaveBeenCalled()
  } finally {
    service.stop()
    folder.resolve(null)
  }
})

it('observes a bound scope immediately while another account and default writer are unresolved', async () => {
  const home = Promise.withResolvers<AgentSessionAccountHome>()
  const defaults = Promise.withResolvers<boolean>()
  let selected = false
  const resolveAccountHome = vi.fn(() => (selected ? home.promise : Promise.resolve(HOME)))
  const store = new AgentModelCatalogStore()
  store.recordSuccess(FINGERPRINT, 'grok', listing('kept'), 'discovery')
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome,
    workspaceMayOverrideDefaultModel: () => defaults.promise
  })
  try {
    await service.demand({ agent: 'grok', workspacePath: '/known' })
    selected = true
    void service.demand({ agent: 'grok', workspacePath: '/unresolved' })
    await vi.waitFor(() => expect(resolveAccountHome).toHaveBeenCalledTimes(2))
    const calls = resolveAccountHome.mock.calls.length
    expect(
      await service.read({ agent: 'grok', workspacePath: '/known', savedOnly: true })
    ).toMatchObject({ models: [{ id: 'kept', isDefault: false }] })
    expect(
      await service.read({ agent: 'grok', workspacePath: '/unresolved', savedOnly: true })
    ).toEqual({ origin: 'unknown' })
    expect(resolveAccountHome).toHaveBeenCalledTimes(calls)
  } finally {
    service.stop()
    home.resolve(HOME)
    defaults.resolve(false)
  }
})

it.each(['success', 'failure'] as const)(
  'retires pending resolution and old %s ingestion across change away and back',
  async (outcome) => {
    const initial = Promise.withResolvers<AgentSessionAccountHome>()
    const stale = Promise.withResolvers<AgentModelCatalogSuccess>()
    let resolving = true
    const store = new AgentModelCatalogStore()
    const probe = vi.fn(() => stale.promise)
    const service = createAgentModelCatalogService({
      store,
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: () => (resolving ? initial.promise : Promise.resolve(HOME)),
      probes: { grok: probe }
    })
    try {
      const first = service.demand({ agent: 'grok' })
      store.expireLaunchScopes()
      service.retireContext()
      store.expireLaunchScopes()
      service.retireContext()
      initial.resolve(HOME)
      await first
      expect(probe).not.toHaveBeenCalled()
      resolving = false
      const old = service.demand({ agent: 'grok' })
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
      store.expireLaunchScopes()
      service.retireContext()
      await store.refresh(FINGERPRINT, 'grok', () =>
        Promise.reject(new Error('new account failure'))
      )
      if (outcome === 'success') {
        stale.resolve(listing('retired'))
      } else {
        stale.reject(new AgentModelCatalogUnavailableError(SIGNED_OUT))
      }
      await old
      expect(store.get(FINGERPRINT)).toBeNull()
      expect(store.failureDetail(FINGERPRINT)).toBe('new account failure')
      expect(service.snapshot({ agent: 'grok', savedOnly: true })).toEqual({ origin: 'unknown' })
    } finally {
      service.stop()
    }
  }
)

it('starts a new listing instead of joining a retired workspace invocation', async () => {
  const stale = Promise.withResolvers<AgentModelCatalogSuccess>()
  let revision = 0
  const probe = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(listing('current'))
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    probes: { grok: probe }
  })
  const request = {
    agent: 'grok',
    workspace: {
      selector: 'folder',
      identity: () => revision,
      resolve: async () => '/folder'
    }
  }
  try {
    const first = service.demand(request)
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    revision += 2
    expect(service.snapshot({ ...request, savedOnly: true })).toEqual({ origin: 'unknown' })
    await service.demand(request)
    expect(probe).toHaveBeenCalledTimes(2)
    stale.resolve(listing('retired'))
    await first
    expect(service.snapshot({ ...request, savedOnly: true })).toMatchObject({
      models: [{ id: 'current' }]
    })
  } finally {
    stale.resolve(listing('retired'))
    service.stop()
  }
})

it('keeps a readable retired conversation warm without listing or committing its delayed live report', async () => {
  const pinned = {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-1' })),
    provider: 'grok',
    accountHome: HOME
  }
  let writable: AgentSessionRecord | undefined = pinned
  const store = new AgentModelCatalogStore()
  const fingerprint = agentModelCatalogFingerprintForRecord(pinned, '/project')
  store.recordSuccess(fingerprint, pinned.provider, listing('saved'), 'discovery')
  const folder = Promise.withResolvers<string | null>()
  const recordWorkspacePath = vi.fn<() => Promise<string | null>>(async () => '/project')
  const probe = vi.fn(async () => listing('unexpected'))
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => agentSessionConversationView(pinned),
    getRecord: () => writable,
    drivesRecord: () => true,
    resolveAccountHome: async () => pinned.accountHome,
    recordWorkspacePath,
    listsInChatFolder: new Set([pinned.provider]),
    probes: { grok: probe }
  })
  const params = {
    agent: pinned.provider,
    sessionId: pinned.sessionId,
    inSessionWorkspace: true as const
  }
  try {
    expect(await service.prepareSaved(params)).toMatchObject({ models: [{ id: 'saved' }] })
    recordWorkspacePath.mockImplementationOnce(() => folder.promise)
    service.recordLiveListing(pinned.sessionId, { models: listing('retired-report').models })
    await vi.waitFor(() => expect(recordWorkspacePath).toHaveBeenCalledTimes(2))
    writable = undefined
    folder.resolve('/project')
    expect(await service.read({ ...params, waitForListing: true })).toMatchObject({
      models: [{ id: 'saved' }]
    })
    expect(store.observation(fingerprint)?.models.map((row) => row.id)).toEqual(['saved'])
    expect(probe).not.toHaveBeenCalled()
    service.recordLiveListing(pinned.sessionId, { models: listing('unwritable-report').models })
    expect(service.snapshot(params)).toMatchObject({ models: [{ id: 'saved' }] })
  } finally {
    folder.resolve('/project')
    service.stop()
  }
})
