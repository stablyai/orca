import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import * as files from 'node:fs/promises'
import SyncDatabase from '../../sqlite/sync-database'
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
import { attachAgentModelCatalogPersistenceOnce } from '../../runtime/structured-agent-model-catalog-wiring'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AGENT_MODEL_CATALOG_MAX_ENTRIES,
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
  AgentModelCatalogStore,
  agentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSessionAccess,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof files>())
}))

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
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
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
        'grok',
        {
          models: [],
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
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
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
    const first = store.refresh('fp-1', 'grok', session, fetch)
    const second = store.refresh('fp-1', 'grok', session, fetch)
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
    const probe = store.refresh('fp-1', 'grok', hungProbe, () =>
      hungProbe({ variable: 'GROK_HOME', path: '/homes/a' })
    )
    expect(store.shouldRefresh('fp-1')).toBe(false)

    const live = await store.refresh('fp-1', 'grok', liveLister(store), async () =>
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
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failFirst = reject))
    )
    void store.refresh(
      'fp-1',
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSecond = resolve))
    )
    const pending = store.pendingListing('fp-1')
    failFirst(new Error('stuck'))
    settleSecond(success('gpt-second'))
    expect((await pending)!.models[0]!.id).toBe('gpt-second')

    void store.refresh('fp-2', 'grok', liveLister(store), async () => {
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
        'grok',
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
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleSlow = resolve))
    )
    await store.refresh('fp-1', 'grok', liveLister(store), async () => success('gpt-fast'))
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
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    const newer = await store.refresh('fp-1', 'grok', liveLister(store), async () =>
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
    const pending = store.refresh('fp-1', 'grok', probe, () =>
      probe({ variable: 'GROK_HOME', path: '/homes/a' })
    )
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'discovery')
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    expect((await pending)!.models[0]!.id).toBe('gpt-probe')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('still writes a pending probe that resolves after a live save, keeping both', async () => {
    const store = new AgentModelCatalogStore()
    let settleProbe!: (success: AgentModelCatalogSuccess) => void
    const probe: AgentModelCatalogProbe = () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => (settleProbe = resolve))
    const pending = store.refresh('fp-1', 'grok', probe, () =>
      probe({ variable: 'GROK_HOME', path: '/homes/a' })
    )
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'live')
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    await pending
    const entry = store.get('fp-1')!
    expect(entry.discovered!.models[0]!.id).toBe('gpt-probe')
    expect(entry.live!.models[0]!.id).toBe('gpt-live')
    // A live save neither postpones the next discovery nor clears its failure back-off.
    store.recordFailure('fp-1', 'timed out')
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'live')
    expect(store.hasActiveFailure('fp-1')).toBe(true)
  })

  it('keeps an older successful listing when the newer entry was evicted', async () => {
    const store = new AgentModelCatalogStore()
    let settleOlder!: (success: AgentModelCatalogSuccess) => void
    const older = store.refresh(
      'fp-1',
      'grok',
      liveLister(store),
      () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleOlder = resolve))
    )
    await store.refresh('fp-1', 'grok', liveLister(store), async () => success('gpt-new'))
    for (let index = 0; index < AGENT_MODEL_CATALOG_MAX_ENTRIES; index++) {
      store.recordSuccess(`other-${index}`, 'grok', success('other'), 'discovery')
    }
    expect(store.get('fp-1')).toBeNull()
    const save = vi.fn()
    await store.attachPersistence({ load: async () => [], save, flush: async () => {} })

    settleOlder(success('gpt-old'))
    expect((await older)!.models[0]!.id).toBe('gpt-old')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-old')
    expect(Array.from(save.mock.calls[0]![0]())).toEqual(
      expect.arrayContaining([expect.objectContaining({ fingerprint: 'fp-1' })])
    )
  })

  it('records a failed refresh as a failure and resolves null without rejecting', async () => {
    const store = new AgentModelCatalogStore()
    const entry = await store.refresh('fp-1', 'grok', liveLister(store), async () => {
      throw new Error('no provider')
    })
    expect(entry).toBeNull()
    expect(store.get('fp-1')).toBeNull()
    expect(store.hasActiveFailure('fp-1')).toBe(true)
    expect(store.failureDetail('fp-1')).toBe('no provider')
  })

  it('keys entries by fingerprint so one account never answers for another', () => {
    const fingerprintA = agentModelCatalogFingerprint({
      agent: 'grok',
      accountHomeVariable: 'GROK_HOME',
      accountHomePath: '/homes/a',
      wslDistro: null
    })
    const fingerprintB = agentModelCatalogFingerprint({
      agent: 'grok',
      accountHomeVariable: 'GROK_HOME',
      accountHomePath: '/homes/b',
      wslDistro: null
    })
    expect(fingerprintA).not.toBe(fingerprintB)
    const store = new AgentModelCatalogStore()
    store.recordSuccess(fingerprintA, 'grok', success('gpt-a'), 'discovery')
    expect(store.get(fingerprintB)).toBeNull()
  })

  it('derives the record fingerprint from the pinned account home', () => {
    const record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'> = {
      provider: 'grok',
      accountHome: { variable: 'GROK_HOME', path: '/homes/a' },
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'ws-1',
        workspaceKind: 'git-worktree'
      }
    }
    expect(agentModelCatalogFingerprintForRecord(record)).toBe(
      agentModelCatalogFingerprint({
        agent: 'grok',
        accountHomeVariable: 'GROK_HOME',
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
    store.recordSuccess('fp', 'grok', success('opus'), 'discovery')
    at += AGENT_MODEL_CATALOG_FRESH_MS
    store.recordSuccess('fp', 'grok', success('opus'), 'discovery')
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.shouldRefresh('fp')).toBe(false)
    store.recordSuccess('fp', 'grok', success('opus', 'sonnet'), 'discovery')
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
      origin: 'live-session'
    })
    store.recordSuccess('fp', 'grok', listing('medium'), 'live')
    // A session-less probe never names the provider's default.
    store.recordSuccess('fp', 'grok', { ...listing(), origin: 'probe' }, 'discovery')
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('medium')
    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')!.models[0]!.defaultEffort).toBe('medium')

    // A newer report replaces it; a model that stops offering it drops it.
    store.recordSuccess('fp', 'grok', listing('high'), 'live')
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('high')
    store.recordSuccess(
      'fp',
      'grok',
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

    store.recordSuccess('fp', 'grok', success('opus', 'sonnet'), 'live')
    store.recordConfiguredDefault('fp', { modelId: 'sonnet', effort: 'high' })
    store.recordSuccess(
      'fp',
      'grok',
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
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
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
    // The failure died with the process: doubt is never a durable fact.
    expect(restarted.hasActiveFailure('fp-2')).toBe(false)
    expect(restarted.get('fp-2')).toBeNull()
  })

  it('keeps a model’s service tiers across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const serviceTiers = [
      { value: 'priority', label: 'Fast', description: '2x speed' },
      { value: 'ultrafast', label: 'Ultrafast' }
    ]
    store.recordSuccess(
      'fp-tiers',
      'grok',
      {
        models: [{ id: 'gpt-a', label: 'A', isDefault: true, efforts: [], serviceTiers }],
        origin: 'probe'
      },
      'discovery'
    )
    await store.flushPersistence()
    const [saved] = await createAgentModelCatalogFilePersistence(directory).load()
    expect(saved?.models[0]?.serviceTiers).toEqual(serviceTiers)
  })

  it('imports complete schema3 sources only after hydration, with current entries and retention winning', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-import-'))
    const seed = new AgentModelCatalogStore()
    for (let i = 0; i < 253; i++) {
      seed.recordSuccess(`fp-${i}`, 'grok', success('disk'), 'discovery')
    }
    seed.recordSuccess('fp-251', 'grok', success('live', 'chosen'), 'live')
    seed.recordConfiguredDefault('fp-251', { modelId: 'chosen', effort: 'high' })
    const rows = Array.from({ length: 253 }, (_, i) => seed.get(`fp-${i}`)!)
    for (const agent of ['claude', 'codex']) {
      seed.recordSuccess(agent, agent, { ...success('display'), complete: true }, 'discovery')
      const entry = seed.get(agent)!
      rows.push({ ...entry, discovered: null, live: entry.discovered })
    }
    const legacy = join(directory, 'agent-model-catalog.json')
    const bytes = `{"version":2,"entries":[null],"padding":${JSON.stringify('🧭'.repeat(18_000))},"version":3,"entries":${JSON.stringify([...rows, { ...rows[0], live: rows[251]!.live }])}}`
    writeFileSync(legacy, bytes)
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    store.recordSuccess('fp-252', 'grok', success('current'), 'live')
    const loading = store.attachPersistence(persistence)
    store.recordSuccess('new', 'grok', success('during'), 'discovery')
    const flushing = store.flushPersistence()
    await Promise.all([loading, flushing])
    const loaded = await persistence.load()
    expect(loaded).toHaveLength(256)
    expect(loaded.find((row) => row.fingerprint === 'fp-252')?.live?.models[0]?.id).toBe('current')
    expect(loaded.find((row) => row.fingerprint === 'new')?.models[0]?.id).toBe('during')
    for (const agent of ['claude', 'codex']) {
      expect(loaded.find((row) => row.agent === agent)).toMatchObject({
        live: null,
        configured: null,
        discovered: { models: [{ id: 'display' }] }
      })
    }
    expect(loaded.find((row) => row.fingerprint === 'fp-0')?.live).toBeNull()
    expect(loaded.find((row) => row.fingerprint === 'fp-251')).toMatchObject({
      discovered: { models: [{ id: 'disk' }] },
      live: { models: [{ id: 'live' }, { id: 'chosen' }] },
      configured: { modelId: 'chosen', effort: 'high' }
    })
    expect(JSON.parse(readFileSync(legacy, 'utf8')).version).toBe(3)
    store.get('fp-252')
    store.recordSuccess('extra', 'grok', success('extra'), 'live')
    await store.flushPersistence()
    expect(await persistence.load()).toHaveLength(256)
    expect(store.get('new')).toBeNull()
    const restored = new AgentModelCatalogStore()
    await restored.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restored.get('fp-251')?.configured?.modelId).toBe('chosen')
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([10, 100])('streams %i changes with backpressure and joined flush', async (count) => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-stream-'))
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    const scans = vi.fn<Parameters<typeof persistence.save>[0]>()
    const save = persistence.save
    vi.spyOn(persistence, 'save').mockImplementation((source) => {
      scans.mockImplementation(source)
      save(scans)
    })
    const { promise: held, resolve: holding } = Promise.withResolvers<void>()
    const { promise: released, resolve: release } = Promise.withResolvers<void>()
    const open = files.open
    const opening = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const write = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
        if (opening.mock.calls.length === 1 && String(data).includes('"fingerprint":"fp-0"')) {
          holding()
          await released
        }
        return write(data, options)
      })
      return handle
    })
    const publishing = vi.spyOn(files, 'rename')
    for (let i = 0; i < count; i++) {
      store.recordSuccess(`fp-${i}`, 'grok', success('model', 'chosen'), 'live')
    }
    expect(opening).not.toHaveBeenCalled()
    expect(scans).not.toHaveBeenCalled()
    const encoded = vi.spyOn(JSON, 'stringify')
    const payloads = () =>
      encoded.mock.calls.filter(([value]) => Object.hasOwn(value ?? {}, 'fingerprint'))
    const first = store.flushPersistence()
    await held
    expect(payloads()).toHaveLength(1)
    expect(scans).toHaveBeenCalledTimes(1)
    at++
    for (let i = 0; i < count; i++) {
      store.recordSuccess(`fp-${i}`, 'grok', success('new', 'chosen'), 'live')
    }
    store.recordConfiguredDefault('fp-0', { modelId: 'chosen' })
    store.recordSuccess('extra', 'grok', success('extra'), 'live')
    expect(store.flushPersistence()).toBe(first)
    expect(opening).toHaveBeenCalledTimes(1)
    expect(payloads()).toHaveLength(1)
    release()
    await first
    expect(payloads()).toHaveLength(count * 2 + 1)
    expect(opening).toHaveBeenCalledTimes(2)
    expect(publishing).toHaveBeenCalledTimes(2)
    // Unchanged reports still replace age; get() reorders without a save notification.
    at++
    store.recordSuccess('fp-1', 'grok', success('new', 'chosen'), 'live')
    store.get('fp-0')
    await store.flushPersistence()
    expect(payloads()).toHaveLength(count * 3 + 2)
    expect(scans).toHaveBeenCalledTimes(7)
    const loaded = await persistence.load()
    expect(loaded.at(-1)?.fingerprint).toBe('fp-0')
    expect(loaded.find((row) => row.fingerprint === 'fp-1')?.live?.at).toBe(at)
    expect(loaded.at(-1)?.configured?.modelId).toBe('chosen')
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })
  it('paces normal starts at 500ms and keeps changes during an active write owed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-cadence-'))
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const started = Date.now()
    const starts: number[] = []
    const open = files.open
    vi.spyOn(files, 'open').mockImplementation((...args) => {
      starts.push(Date.now())
      return open(...args)
    })
    const rename = files.rename
    const { promise: committed, resolve: firstCommitted } = Promise.withResolvers<void>()
    vi.spyOn(files, 'rename').mockImplementation(async (...args) => {
      await rename(...args)
      if (starts.length === 1) {
        store.recordSuccess('newer', 'grok', success('newer'), 'live')
        firstCommitted()
      }
    })
    try {
      store.recordSuccess('first', 'grok', success('first'), 'live')
      await vi.advanceTimersByTimeAsync(499)
      expect(starts).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await committed
      await persistence.load()
      await vi.advanceTimersByTimeAsync(499)
      expect(starts).toEqual([started + 500])
      await vi.advanceTimersByTimeAsync(1)
      await store.flushPersistence()
      expect(starts).toEqual([started + 500, started + 1_000])
      expect((await persistence.load()).map((row) => row.fingerprint)).toEqual(['first', 'newer'])
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each(['encode', 'write', 'close', 'rename', 'uncertain', 'uncertain-revert', 'retire'])(
    'preserves complete authority and latest retry after %s failure',
    async (stage) => {
      const directory = mkdtempSync(join(tmpdir(), 'catalog-publication-'))
      const path = join(directory, 'agent-model-catalog.json')
      const seed = new AgentModelCatalogStore()
      const kept = seed.recordSuccess('kept', 'grok', success('kept'), 'discovery')!
      const old = seed.recordSuccess('old', 'grok', success('old'), 'discovery')!
      writeFileSync(path, JSON.stringify({ version: 3, entries: [kept, old] }))
      let source = new Map([kept, old].map((row) => [row.fingerprint, row]))
      const persistence = createAgentModelCatalogFilePersistence(directory)
      await persistence.attach!(() => source.values(), vi.fn())
      await persistence.flush()
      const bytes = readFileSync(path, 'utf8')
      seed.recordConfiguredDefault('old', { modelId: 'old', effort: 'high' })
      source.set('old', seed.get('old')!)
      source.delete('kept')
      source.set('new', seed.recordSuccess('new', 'grok', success('new'), 'live')!)
      const attempted = [...source.values()]
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (stage === 'encode') {
        vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
          throw new Error(stage)
        })
      }
      const open = files.open
      const closing = vi.fn<() => Promise<void>>()
      const opening = vi.spyOn(files, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        const close = handle.close.bind(handle)
        closing.mockImplementation(async () => {
          if (stage === 'retire' || (stage === 'close' && closing.mock.calls.length === 1)) {
            throw new Error(stage)
          }
          await close()
        })
        vi.spyOn(handle, 'close').mockImplementation(closing)
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
          if (typeof data === 'string' && data.includes('"fingerprint":"old"')) {
            source = new Map([['kept', kept]])
            source.set('old', stage.endsWith('revert') ? old : seed.get('old')!)
            if (stage === 'write' || stage === 'retire') {
              throw new Error(stage)
            }
          }
          return write(data, options)
        })
        return handle
      })
      const rename = files.rename
      vi.spyOn(files, 'rename').mockImplementation(async (...args) => {
        if (stage.startsWith('uncertain')) {
          await rename(...args)
        }
        throw new Error(stage)
      })
      persistence.save(() => source.values())
      await persistence.flush()
      expect(warn).toHaveBeenCalledTimes(1)
      if (stage === 'retire') {
        await persistence.flush()
        expect(opening).toHaveBeenCalledTimes(1)
        expect(closing).toHaveBeenCalledTimes(2)
      }
      const published = await createAgentModelCatalogFilePersistence(directory).load()
      expect(published).toEqual(stage.startsWith('uncertain') ? attempted : [kept, old])
      if (!stage.startsWith('uncertain')) {
        expect(readFileSync(path, 'utf8')).toBe(bytes)
      }
      await new Promise((resolve) => setTimeout(resolve, 550))
      expect(opening).toHaveBeenCalledTimes(1)
      vi.restoreAllMocks()
      await persistence.flush()
      expect(await persistence.load()).toEqual([...source.values()])
      expect((await files.readdir(directory)).sort()).toEqual(['agent-model-catalog.json'])
      source.clear()
      persistence.save(() => source.values())
      await persistence.flush()
      expect(await createAgentModelCatalogFilePersistence(directory).load()).toEqual([])
      rmSync(directory, { recursive: true, force: true })
    }
  )
  it('retries transient initialization through hydrate end before publishing current memory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-authority-'))
    const path = join(directory, 'agent-model-catalog.json')
    const seed = new AgentModelCatalogStore()
    seed.recordSuccess('disk', 'grok', success('disk'), 'discovery')
    writeFileSync(`${path}.backup`, JSON.stringify({ version: 3, entries: [seed.get('disk')] }))
    mkdirSync(path)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new AgentModelCatalogStore()
    const persistence = createAgentModelCatalogFilePersistence(directory)
    await store.attachPersistence(persistence)
    store.recordSuccess('memory', 'grok', success('memory'), 'live')
    await store.flushPersistence()
    expect(store.get('disk')).toBeNull()
    expect(store.get('memory')).not.toBeNull()
    rmSync(path, { recursive: true })
    renameSync(`${path}.backup`, path)
    await store.flushPersistence()
    expect(store.get('disk')?.models[0]?.id).toBe('disk')
    expect((await persistence.load()).map((row) => row.fingerprint)).toEqual(['memory', 'disk'])
    warn.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  })
  it.each([
    '{"version":3,"entries":[]} trailing',
    '{"version":3,"entries":[]',
    '{"version":4,"entries":[]}',
    '{"version":3,"entries":[],"entries":{}}'
  ])('preserves an invalid final schema3 document: %s', async (bytes) => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-framing-'))
    const legacy = join(directory, 'agent-model-catalog.json')
    writeFileSync(legacy, bytes)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('memory', 'grok', success('memory'), 'live')
    await store.flushPersistence()
    expect(store.get('memory')).not.toBeNull()
    expect(readFileSync(legacy, 'utf8')).toBe(bytes)
    expect(await files.readdir(directory)).toEqual(['agent-model-catalog.json'])
    warn.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  })
  it('keeps the once-attached catalog usable after the runtime journal closes and reinstalls', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-runtime-'))
    const journal = new SyncDatabase(join(directory, 'journal.db'))
    await attachAgentModelCatalogPersistenceOnce(directory)
    journal.close()
    agentModelCatalogStore.recordSuccess('runtime', 'grok', success('first'), 'live')
    await agentModelCatalogStore.flushPersistence()
    await attachAgentModelCatalogPersistenceOnce(join(directory, 'unused'))
    agentModelCatalogStore.recordSuccess('runtime', 'grok', success('reinstalled'), 'live')
    await agentModelCatalogStore.flushPersistence()
    expect((await createAgentModelCatalogFilePersistence(directory).load())[0]?.models[0]?.id).toBe(
      'reinstalled'
    )
    expect(existsSync(join(directory, 'unused'))).toBe(false)
    rmSync(directory, { recursive: true, force: true })
  })
})
