import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { agentModelCatalogFingerprintForRecord } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

// A live session lists every turn; the account-level discovery is the only source of the configured
// default. These pin that the first can never starve, outrun or erase the second.

const HOME: AgentSessionAccountHome = { variable: 'GROK_HOME', path: '/homes/grok' }

const RECORD = {
  sessionId: 'grok-session',
  provider: 'grok',
  accountHome: HOME,
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'ws-1',
    workspaceKind: 'git-worktree'
  }
} as const satisfies Pick<AgentSessionRecord, 'sessionId' | 'provider' | 'accountHome' | 'location'>

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' }
]

function discovery(defaultModel: string): AgentModelCatalogSuccess {
  return {
    models: ['grok-4', 'grok-3-mini'].map((id) => ({
      id,
      label: id,
      isDefault: id === defaultModel,
      efforts: EFFORTS,
      ...(id === defaultModel ? { defaultEffort: 'high' } : {})
    })),
    fastModeTierByModel: new Map(),
    origin: 'probe'
  }
}

/** What a running Grok chat reports: no default, and the model it switched to. */
const LIVE: AgentSessionModelOption[] = [
  { id: 'grok-4', label: 'grok-4', isDefault: false, efforts: EFFORTS },
  { id: 'grok-3-mini', label: 'grok-3-mini', isDefault: false, efforts: EFFORTS },
  { id: 'grok-code', label: 'grok-code', isDefault: false, efforts: [] }
]

function harness(probe: () => Promise<AgentModelCatalogSuccess>) {
  let now = 1_000
  const store = new AgentModelCatalogStore({ now: () => now })
  const probes = vi.fn(probe)
  const catalog = createAgentModelCatalogService({
    store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only provider, accountHome and location.
    getRecord: () => RECORD as unknown as AgentSessionRecord,
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    probes: { grok: probes },
    listingNamesConfiguredModel: new Set(['grok'])
  })
  const read = async () => {
    const result = await catalog.read({ agent: 'grok', waitForListing: true })
    return result.origin === 'unknown' ? null : result
  }
  const defaultOf = async () => (await read())?.models.find((model) => model.isDefault)?.id
  return {
    store,
    catalog,
    probes,
    read,
    defaultOf,
    advance: (ms: number) => (now += ms),
    saveLive: () => catalog.recordLiveListing(RECORD.sessionId, { models: LIVE })
  }
}

describe('a live listing beside the account-level discovery', () => {
  it('merges a discovery that resolves after a live save instead of dropping it', async () => {
    let settle!: (success: AgentModelCatalogSuccess) => void
    const run = harness(() => new Promise((resolve) => (settle = resolve)))
    // The first read starts the account's discovery; a chat lists while it is still running.
    expect(await run.catalog.read({ agent: 'grok' })).toEqual({
      origin: 'unknown',
      listingInProgress: true
    })
    run.saveLive()
    settle(discovery('grok-4'))
    await vi.waitFor(() =>
      expect(run.store.get(agentModelCatalogFingerprintForRecord(RECORD))?.discovered).not.toBe(
        null
      )
    )

    const read = await run.read()
    expect(read?.listingNamesConfiguredModel).toBe(true)
    expect(await run.defaultOf()).toBe('grok-4')
    // The session's newer membership stays, with the default effort discovery named.
    expect(read?.models.map((model) => model.id)).toEqual(['grok-4', 'grok-3-mini', 'grok-code'])
    expect(read?.models[0]?.defaultEffort).toBe('high')
  })

  it('names the default on a cold account whose first listing came from a live chat', async () => {
    const run = harness(async () => discovery('grok-4'))
    run.saveLive()
    // A live listing alone names no default and does not count as fresh, so a read lists the account.
    await run.catalog.read({ agent: 'grok' })
    expect(run.probes).toHaveBeenCalledTimes(1)
    await vi.waitFor(async () => expect(await run.defaultOf()).toBe('grok-4'))
  })

  it('still refreshes the account listing after ten minutes of live saves', async () => {
    let configured = 'grok-4'
    const run = harness(async () => discovery(configured))
    expect(await run.defaultOf()).toBe('grok-4')
    expect(run.probes).toHaveBeenCalledTimes(1)

    // The user changes the account's default while chats keep listing every minute.
    configured = 'grok-3-mini'
    for (let minute = 0; minute < 11; minute++) {
      run.advance(60_000)
      run.saveLive()
    }
    expect(run.store.shouldRefresh(agentModelCatalogFingerprintForRecord(RECORD))).toBe(true)
    await run.catalog.read({ agent: 'grok' })
    expect(run.probes).toHaveBeenCalledTimes(2)
    await vi.waitFor(async () => expect(await run.defaultOf()).toBe('grok-3-mini'))
  })

  it('does not refresh while the discovery is younger than its freshness window', async () => {
    const run = harness(async () => discovery('grok-4'))
    await run.read()
    run.advance(AGENT_MODEL_CATALOG_FRESH_MS - 1)
    run.saveLive()
    await run.read()
    expect(run.probes).toHaveBeenCalledTimes(1)
  })
})
