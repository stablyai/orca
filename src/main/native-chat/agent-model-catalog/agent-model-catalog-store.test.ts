import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogFingerprintForRecord
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

function models(...ids: string[]): AgentSessionModelOption[] {
  return ids.map((id, index) => ({
    id,
    label: id.toUpperCase(),
    isDefault: index === 0,
    efforts: [{ value: 'high', label: 'High' }]
  }))
}

function success(...ids: string[]): AgentModelCatalogSuccess {
  return {
    models: models(...ids),
    fastModeTierByModel: new Map([[ids[0]!, 'fast-tier']]),
    origin: 'live-session'
  }
}

describe('agent model catalog store', () => {
  it('serves an entry at any age and flags staleness at the refresh threshold', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    const entry = store.get('fp-1')!
    expect(entry.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(store.isStale(entry)).toBe(false)
    expect(store.shouldRefresh('fp-1')).toBe(false)
    at += AGENT_MODEL_CATALOG_FRESH_MS
    expect(store.get('fp-1')).not.toBeNull()
    expect(store.shouldRefresh('fp-1')).toBe(true)
  })

  it('never memoizes an empty list as a catalog', () => {
    const store = new AgentModelCatalogStore()
    expect(
      store.recordSuccess('fp-1', 'codex', {
        models: [],
        fastModeTierByModel: new Map(),
        origin: 'live-session'
      })
    ).toBeNull()
    expect(store.get('fp-1')).toBeNull()
  })

  it('holds a failure under its TTL without touching the last good entry', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    store.recordFailure('fp-1', 'timed out')
    expect(store.get('fp-1')!.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(store.hasActiveFailure('fp-1')).toBe(true)
    expect(store.failureDetail('fp-1')).toBe('timed out')
    expect(store.shouldRefresh('fp-1')).toBe(false)
    at += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
    expect(store.hasActiveFailure('fp-1')).toBe(false)
  })

  it('joins an in-flight refresh instead of starting a second fetch', async () => {
    const store = new AgentModelCatalogStore()
    let settle!: (value: AgentModelCatalogSuccess) => void
    const fetch = vi.fn(
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settle = resolve))
    )
    const first = store.refresh('fp-1', 'codex', fetch)
    const second = store.refresh('fp-1', 'codex', fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    settle(success('gpt-a'))
    const [entryA, entryB] = await Promise.all([first, second])
    expect(entryA).toBe(entryB)
    expect(entryA!.models[0]!.id).toBe('gpt-a')
  })

  it('records a failed refresh as a failure and resolves null without rejecting', async () => {
    const store = new AgentModelCatalogStore()
    const entry = await store.refresh('fp-1', 'codex', async () => {
      throw new Error('no provider')
    })
    expect(entry).toBeNull()
    expect(store.get('fp-1')).toBeNull()
    expect(store.hasActiveFailure('fp-1')).toBe(true)
    expect(store.failureDetail('fp-1')).toBe('no provider')
  })

  it('keys entries by fingerprint so one account never answers for another', () => {
    const fingerprintA = agentModelCatalogFingerprint({
      agent: 'codex',
      accountHomeVariable: 'CODEX_HOME',
      accountHomePath: '/homes/a',
      wslDistro: null
    })
    const fingerprintB = agentModelCatalogFingerprint({
      agent: 'codex',
      accountHomeVariable: 'CODEX_HOME',
      accountHomePath: '/homes/b',
      wslDistro: null
    })
    expect(fingerprintA).not.toBe(fingerprintB)
    const store = new AgentModelCatalogStore()
    store.recordSuccess(fingerprintA, 'codex', success('gpt-a'))
    expect(store.get(fingerprintB)).toBeNull()
  })

  it('derives the record fingerprint from the pinned account home', () => {
    const record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'> = {
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/homes/a' },
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    }
    expect(agentModelCatalogFingerprintForRecord(record)).toBe(
      agentModelCatalogFingerprint({
        agent: 'codex',
        accountHomeVariable: 'CODEX_HOME',
        accountHomePath: '/homes/a',
        wslDistro: null
      })
    )
  })

  it('rewrites the file only when a listing changes, while still refreshing its age', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    const save = vi.fn()
    void store.attachPersistence({ load: async () => [], save, flush: async () => {} })
    store.recordSuccess('fp', 'claude', success('opus'))
    at += AGENT_MODEL_CATALOG_FRESH_MS
    store.recordSuccess('fp', 'claude', success('opus'))
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.shouldRefresh('fp')).toBe(false)
    store.recordSuccess('fp', 'claude', success('opus', 'sonnet'))
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("keeps a live child's default effort through a listing that names none, across a restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const efforts = [
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ]
    const listing = (defaultEffort?: string): AgentModelCatalogSuccess => ({
      models: [
        {
          id: 'opus',
          label: 'Opus',
          isDefault: true,
          efforts,
          ...(defaultEffort ? { defaultEffort } : {})
        }
      ],
      fastModeTierByModel: new Map(),
      origin: 'live-session'
    })
    store.recordSuccess('fp', 'claude', listing('medium'))
    // A session-less probe never names Claude's default.
    store.recordSuccess('fp', 'claude', { ...listing(), origin: 'probe' })
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('medium')
    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')!.models[0]!.defaultEffort).toBe('medium')

    // A newer report replaces it; a model that stops offering it drops it.
    store.recordSuccess('fp', 'claude', listing('high'))
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('high')
    store.recordSuccess('fp', 'claude', {
      ...listing(),
      models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [efforts[0]!] }]
    })
    expect(store.get('fp')!.models[0]).not.toHaveProperty('defaultEffort')
  })

  it('persists successes only and hydrates them across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    store.recordFailure('fp-2', 'timed out')
    await vi.waitFor(
      async () => {
        const persisted = await createAgentModelCatalogFilePersistence(directory).load()
        expect(persisted.map((entry) => entry.fingerprint)).toEqual(['fp-1'])
      },
      { timeout: 3_000 }
    )
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const entry = restarted.get('fp-1')!
    expect(entry.models.map((model) => model.id)).toEqual(['gpt-a'])
    expect(entry.fastModeTierByModel).toEqual({ 'gpt-a': 'fast-tier' })
    // The failure died with the process: doubt is never a durable fact.
    expect(restarted.hasActiveFailure('fp-2')).toBe(false)
    expect(restarted.get('fp-2')).toBeNull()
  })

  it('writes a coalesced save at once when flushed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('fp-1', 'codex', success('gpt-a'))
    await store.flushPersistence()
    const persisted = await createAgentModelCatalogFilePersistence(directory).load()
    expect(persisted.map((entry) => entry.fingerprint)).toEqual(['fp-1'])
  })

  it('loads nothing from a malformed persistence file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const persistence = createAgentModelCatalogFilePersistence(directory)
    expect(await persistence.load()).toEqual([])
  })
})
