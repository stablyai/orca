import { describe, expect, it, vi } from 'vitest'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const HOME = { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' }
const FINGERPRINT = agentModelCatalogFingerprint({
  agent: 'claude',
  accountHome: HOME,
  wslDistro: null
})

function listing(id?: string): AgentModelCatalogSuccess {
  return {
    models: id ? [{ id, label: id, isDefault: true, efforts: [] }] : [],
    origin: 'probe'
  }
}

describe('model discovery recovery on the execution host', () => {
  it.each(['empty', 'error'] as const)(
    'retries a %s discovery after backoff without restarting the store',
    async (failure) => {
      let now = 1_000
      const store = new AgentModelCatalogStore({ now: () => now })
      const probe = vi.fn(async () => {
        if (probe.mock.calls.length > 1) {
          return listing('recovered')
        }
        if (failure === 'error') {
          throw new Error('temporarily unavailable')
        }
        return listing()
      })
      const service = createAgentModelCatalogService({
        store,
        getRecord: () => undefined,
        drivesRecord: () => true,
        resolveAccountHome: async () => HOME,
        probes: { claude: probe }
      })
      const read = () => service.read({ agent: 'claude', waitForListing: true })

      expect(await read()).toEqual({ origin: 'unknown' })
      expect(store.get(FINGERPRINT)).toBeNull()
      now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS - 1
      expect(await read()).toEqual({ origin: 'unknown' })
      expect(probe).toHaveBeenCalledTimes(1)
      now += 1
      expect(await read()).toMatchObject({ models: [{ id: 'recovered' }] })
      expect(probe).toHaveBeenCalledTimes(2)
      expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    }
  )

  it('keeps a persisted list usable through an empty refresh, then replaces it on recovery', async () => {
    let now = 1_000
    const store = new AgentModelCatalogStore({ now: () => now })
    const saved = store.recordSuccess(FINGERPRINT, 'claude', listing('saved'), 'discovery')!
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [saved], save, flush: async () => {} })
    now += AGENT_MODEL_CATALOG_FRESH_MS
    const probe = vi.fn(async () =>
      probe.mock.calls.length === 1 ? listing() : listing('recovered')
    )
    const refresh = () => store.refresh(FINGERPRINT, 'claude', probe, () => probe())

    expect(await refresh()).toBeNull()
    expect(store.get(FINGERPRINT)?.models).toEqual(saved.models)
    expect(save).not.toHaveBeenCalled()
    expect(store.shouldRefresh(FINGERPRINT)).toBe(false)
    now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    expect(store.shouldRefresh(FINGERPRINT)).toBe(true)
    expect((await refresh())?.models).toEqual(listing('recovered').models)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('lets a fresh live listing retry immediately during probe failure backoff', async () => {
    const store = new AgentModelCatalogStore()
    const probe = async () => {
      throw new Error('temporarily unavailable')
    }
    await store.refresh(FINGERPRINT, 'claude', probe, probe)
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(true)
    const session = { store, fingerprint: FINGERPRINT, accountHomePath: HOME.path }

    expect(
      (await store.refresh(FINGERPRINT, 'claude', session, async () => listing('live')))?.models
    ).toEqual(listing('live').models)
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
  })
})
