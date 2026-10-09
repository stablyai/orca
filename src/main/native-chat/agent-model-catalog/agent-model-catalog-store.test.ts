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
  AGENT_MODEL_CATALOG_MAX_ENTRIES,
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSessionAccess,
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

/** A live session's per-spawn handle; each call is a distinct lister. */
function liveLister(store: AgentModelCatalogStore): AgentModelCatalogSessionAccess {
  return { store, fingerprint: 'fp-1', accountHomePath: '/homes/a' }
}

describe('agent model catalog store', () => {
  it('serves an entry at any age and flags staleness at the refresh threshold', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'codex', success('gpt-a'), 'discovery')
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
      store.recordSuccess(
        'fp-1',
        'codex',
        {
          models: [],
          fastModeTierByModel: new Map(),
          origin: 'live-session'
        },
        'discovery'
      )
    ).toBeNull()
    expect(store.get('fp-1')).toBeNull()
  })

  it('holds a failure under its TTL without touching the last good entry', () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'codex', success('gpt-a'), 'discovery')
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
    const session = liveLister(store)
    const first = store.refresh('fp-1', 'codex', session, fetch)
    const second = store.refresh('fp-1', 'codex', session, fetch)
    expect(fetch).toHaveBeenCalledTimes(1)
    settle(success('gpt-a'))
    const [entryA, entryB] = await Promise.all([first, second])
    expect(entryA).toBe(entryB)
    expect(entryA!.models[0]!.id).toBe('gpt-a')
  })

  it('never makes a live session wait on another lister that hangs', async () => {
    const store = new AgentModelCatalogStore()
    let failProbe!: (error: Error) => void
    const hungProbe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failProbe = reject))
    const probe = store.refresh('fp-1', 'codex', hungProbe, () =>
      hungProbe({ variable: 'CODEX_HOME', path: '/homes/a' })
    )
    expect(store.shouldRefresh('fp-1')).toBe(false)

    const live = await store.refresh('fp-1', 'codex', liveLister(store), async () =>
      success('gpt-live')
    )
    expect(live!.models[0]!.id).toBe('gpt-live')

    // The probe still reports its own failure; the live listing it lost to stays served.
    failProbe(new Error('codex app-server session exceeded 15000ms'))
    expect(await probe).toBeNull()
    expect(store.failureDetail('fp-1')).toBe('codex app-server session exceeded 15000ms')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('answers a pending read with the first listing that succeeds, or null once all fail', async () => {
    const store = new AgentModelCatalogStore()
    expect(store.pendingListing('fp-1')).toBeNull()
    let failFirst!: (error: Error) => void
    let settleSecond!: (success: AgentModelCatalogSuccess) => void
    void store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failFirst = reject))
    )
    void store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSecond = resolve))
    )
    const pending = store.pendingListing('fp-1')
    failFirst(new Error('stuck'))
    settleSecond(success('gpt-second'))
    expect((await pending)!.models[0]!.id).toBe('gpt-second')

    void store.refresh('fp-2', 'codex', liveLister(store), async () => {
      throw new Error('no provider')
    })
    expect(await store.pendingListing('fp-2')).toBeNull()
  })

  it('ends a picker wait at its deadline even while a listing remains active', async () => {
    vi.useFakeTimers()
    try {
      const store = new AgentModelCatalogStore()
      let settle!: (success: AgentModelCatalogSuccess) => void
      const listing = store.refresh(
        'fp-1',
        'codex',
        liveLister(store),
        () => new Promise<AgentModelCatalogSuccess>((resolve) => (settle = resolve))
      )
      const waited = store.pendingListing('fp-1')
      await vi.advanceTimersByTimeAsync(AGENT_MODEL_CATALOG_PICKER_WAIT_MS)
      expect(await waited).toBeNull()
      settle(success('gpt-late'))
      expect((await listing)!.models[0]!.id).toBe('gpt-late')
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds back a probe until every lister settles, then lets the account refresh again', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    let settleSlow!: (success: AgentModelCatalogSuccess) => void
    const slow = store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSlow = resolve))
    )
    await store.refresh('fp-1', 'codex', liveLister(store), async () => success('gpt-fast'))
    at += AGENT_MODEL_CATALOG_FRESH_MS
    expect(store.shouldRefresh('fp-1')).toBe(false)

    settleSlow(success('gpt-slow'))
    await slow
    at += AGENT_MODEL_CATALOG_FRESH_MS
    // A leftover in-flight record here would suppress every later refresh for the account.
    expect(store.shouldRefresh('fp-1')).toBe(true)
  })

  it('keeps the newer completed listing when an older chat finishes later', async () => {
    const store = new AgentModelCatalogStore()
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [], save, flush: async () => {} })
    let settleOlder!: (success: AgentModelCatalogSuccess) => void
    const older = store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    const newer = await store.refresh('fp-1', 'codex', liveLister(store), async () =>
      success('gpt-new')
    )
    settleOlder(success('gpt-old'))
    const olderResult = await older

    expect(newer!.models[0]!.id).toBe('gpt-new')
    expect(olderResult!.models[0]!.id).toBe('gpt-old')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-new')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('keeps a direct live update ahead of a pending older probe', async () => {
    const store = new AgentModelCatalogStore()
    let settleProbe!: (success: AgentModelCatalogSuccess) => void
    const probe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (settleProbe = resolve))
    const pending = store.refresh('fp-1', 'codex', probe, () =>
      probe({ variable: 'CODEX_HOME', path: '/homes/a' })
    )
    store.recordSuccess('fp-1', 'codex', success('gpt-live'), 'discovery')
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    expect((await pending)!.models[0]!.id).toBe('gpt-probe')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('still writes a pending probe that resolves after a live save, keeping both', async () => {
    const store = new AgentModelCatalogStore()
    let settleProbe!: (success: AgentModelCatalogSuccess) => void
    const probe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (settleProbe = resolve))
    const pending = store.refresh('fp-1', 'codex', probe, () =>
      probe({ variable: 'CODEX_HOME', path: '/homes/a' })
    )
    store.recordSuccess('fp-1', 'codex', success('gpt-live'), 'live')
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    await pending
    const entry = store.get('fp-1')!
    expect(entry.discovered!.models[0]!.id).toBe('gpt-probe')
    expect(entry.live!.models[0]!.id).toBe('gpt-live')
    // A live save neither postpones the next discovery nor clears its failure back-off.
    store.recordFailure('fp-1', 'timed out')
    store.recordSuccess('fp-1', 'codex', success('gpt-live'), 'live')
    expect(store.hasActiveFailure('fp-1')).toBe(true)
  })

  it('keeps an older successful listing when the newer entry was evicted', async () => {
    const store = new AgentModelCatalogStore()
    let settleOlder!: (success: AgentModelCatalogSuccess) => void
    const older = store.refresh(
      'fp-1',
      'codex',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    await store.refresh('fp-1', 'codex', liveLister(store), async () => success('gpt-new'))
    for (let index = 0; index < AGENT_MODEL_CATALOG_MAX_ENTRIES; index++) {
      store.recordSuccess(`other-${index}`, 'codex', success('other'), 'discovery')
    }
    expect(store.get('fp-1')).toBeNull()
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [], save, flush: async () => {} })

    settleOlder(success('gpt-old'))
    expect((await older)!.models[0]!.id).toBe('gpt-old')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-old')
    expect(save).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ fingerprint: 'fp-1' })])
    )
  })

  it('records a failed refresh as a failure and resolves null without rejecting', async () => {
    const store = new AgentModelCatalogStore()
    const entry = await store.refresh('fp-1', 'codex', liveLister(store), async () => {
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
    store.recordSuccess(fingerprintA, 'codex', success('gpt-a'), 'discovery')
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
    store.recordSuccess('fp', 'claude', success('opus'), 'discovery')
    at += AGENT_MODEL_CATALOG_FRESH_MS
    store.recordSuccess('fp', 'claude', success('opus'), 'discovery')
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.shouldRefresh('fp')).toBe(false)
    store.recordSuccess('fp', 'claude', success('opus', 'sonnet'), 'discovery')
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
    store.recordSuccess('fp', 'claude', listing('medium'), 'live')
    // A session-less probe never names Claude's default.
    store.recordSuccess('fp', 'claude', { ...listing(), origin: 'probe' }, 'discovery')
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('medium')
    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')!.models[0]!.defaultEffort).toBe('medium')

    // A newer report replaces it; a model that stops offering it drops it.
    store.recordSuccess('fp', 'claude', listing('high'), 'live')
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('high')
    store.recordSuccess(
      'fp',
      'claude',
      {
        ...listing(),
        models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [efforts[0]!] }]
      },
      'live'
    )
    expect(store.get('fp')!.models[0]).not.toHaveProperty('defaultEffort')
  })

  it('keeps a CLI-resolved configured default through later listings and a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    // Never on its own: there is no catalog to name a default in yet.
    store.recordConfiguredDefault('fp', { modelId: 'sonnet' })
    expect(store.get('fp')).toBeNull()

    store.recordSuccess('fp', 'claude', success('opus', 'sonnet'), 'live')
    store.recordConfiguredDefault('fp', { modelId: 'sonnet', effort: 'high' })
    store.recordSuccess(
      'fp',
      'claude',
      { ...success('opus', 'sonnet'), origin: 'probe' },
      'discovery'
    )
    const named = (entry: ReturnType<typeof store.get>) =>
      entry?.models.filter((model) => model.isDefault).map((model) => model.id)
    expect(named(store.get('fp'))).toEqual(['sonnet'])

    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')?.configured).toMatchObject({
      modelId: 'sonnet',
      effort: 'high'
    })
    expect(named(restarted.get('fp'))).toEqual(['sonnet'])
    const sonnet = restarted.get('fp')?.models.find((model) => model.id === 'sonnet')
    expect(sonnet?.defaultEffort).toBe('high')

    restarted.recordConfiguredDefault('fp', null)
    expect(restarted.get('fp')?.configured).toBeNull()
    expect(restarted.get('fp')?.models.find((model) => model.id === 'sonnet')).not.toHaveProperty(
      'defaultEffort'
    )
  })

  it('persists successes only and hydrates them across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('fp-1', 'codex', success('gpt-a'), 'discovery')
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
    store.recordSuccess('fp-1', 'codex', success('gpt-a'), 'discovery')
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
