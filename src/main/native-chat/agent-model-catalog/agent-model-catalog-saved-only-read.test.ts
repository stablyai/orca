import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
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
    const service = createAgentModelCatalogService({
      store,
      getRecord: (sessionId) => (sessionId === record.sessionId ? record : undefined),
      drivesRecord: () => true,
      resolveAccountHome: async () => HOME,
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

    await service.read({ agent: 'grok' })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('answers from the saved entry and starts nothing, however old the entry is', async () => {
    const { store, probe, service, advance } = rig()
    store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    advance(AGENT_MODEL_CATALOG_FRESH_MS)
    const result = await service.read({ agent: 'grok', savedOnly: true })
    expect(result).toMatchObject({ origin: 'probe', models: [{ id: 'grok-4.7' }] })
    expect(result).not.toHaveProperty('listingInProgress')
    expect(store.pendingListing(FINGERPRINT)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    await service.read({ agent: 'grok' })
    expect(probe).toHaveBeenCalledTimes(1)
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
      .refresh(FINGERPRINT, 'grok', probe, () =>
        Promise.reject(new AgentModelCatalogUnavailableError(SIGNED_OUT))
      )
      .catch(() => undefined)
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
    expect(await opencode.service.read({ agent: 'opencode', savedOnly: true })).not.toHaveProperty(
      'defaultHoldsInEveryWorkspace'
    )
  })
})
