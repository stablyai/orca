import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
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

// A client preloads every agent's saved list through `savedOnly`: the answer comes from what the
// host saved, and no listing, probe or re-check of a held reason starts.

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
  it('answers from the saved entry and starts nothing, however old the entry is', async () => {
    const { store, probe, service, advance } = rig()
    store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    advance(AGENT_MODEL_CATALOG_FRESH_MS)
    const result = await service.read({ agent: 'grok', savedOnly: true })
    expect(result).toMatchObject({ origin: 'probe', models: [{ id: 'grok-4.7' }] })
    expect(result).not.toHaveProperty('listingInProgress')
    expect(store.pendingListing(FINGERPRINT)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    // The same read without `savedOnly` refreshes the aged entry: the probe is what the flag skips.
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
    // OpenCode's listing names no default, and a project's own config may pick its model.
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
