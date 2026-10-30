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
  AGENT_MODEL_CATALOG_PICKER_WAIT_MS,
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
    origin: 'live-session'
  }
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

  it('holds a failure under its TTL without touching the last good entry', async () => {
    let at = 1_000
    const store = new AgentModelCatalogStore({ now: () => at })
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
    await store.refresh('fp-1', 'grok', () => Promise.reject(new Error('timed out')))
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
    const first = store.refresh('fp-1', 'grok', fetch)
    const second = store.refresh('fp-1', 'grok', fetch)
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
    settle(success('gpt-a'))
    const [entryA, entryB] = await Promise.all([first, second])
    expect(entryA).toBe(entryB)
    expect(entryA!.models[0]!.id).toBe('gpt-a')
  })

  it('never makes a live session wait on another lister that hangs', async () => {
    const store = new AgentModelCatalogStore()
    let failProbe!: (error: Error) => void
    const hungProbe = () =>
      new Promise<AgentModelCatalogSuccess>((_resolve, reject) => (failProbe = reject))
    const probe = store.refresh('fp-1', 'grok', hungProbe)
    expect(store.shouldRefresh('fp-1')).toBe(false)

    await Promise.resolve()
    const live = store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'live')
    expect(live!.models[0]!.id).toBe('gpt-live')

    failProbe(new Error('codex app-server session exceeded 15000ms'))
    expect(await probe).toBeNull()
    expect(store.failureDetail('fp-1')).toBe('codex app-server session exceeded 15000ms')
    expect(store.get('fp-1')!.models[0]!.id).toBe('gpt-live')
  })

  it('answers pending reads on success and releases all waiters on failure', async () => {
    const store = new AgentModelCatalogStore()
    expect(store.pendingListing('fp-1')).toBeNull()
    const answer = Promise.withResolvers<AgentModelCatalogSuccess>()
    const flight = store.refresh('fp-1', 'grok', () => answer.promise)
    const pending = store.pendingListing('fp-1')
    answer.resolve(success('gpt-second'))
    expect((await pending)!.models[0]!.id).toBe('gpt-second')
    await flight
    const failed = store.refresh('fp-2', 'grok', () => {
      throw new Error('no provider')
    })
    const read = store.pendingListing('fp-2')
    const terminal = store.pendingListing('fp-2', true, true)
    expect(await Promise.all([failed, read, terminal])).toEqual([null, null, null])
    expect(store.isListing('fp-2')).toBe(false)
    expect(store.failureDetail('fp-2')).toBe('no provider')
  })

  it.each(['success', 'failure'] as const)(
    'retires ignored-abort owners and fences late %s after replacement',
    async (outcome) => {
      const store = new AgentModelCatalogStore()
      const owner = new AbortController()
      const joiner = new AbortController()
      const old = Promise.withResolvers<AgentModelCatalogSuccess>()
      const next = Promise.withResolvers<AgentModelCatalogSuccess>()
      const listing = store.refresh('fp', 'grok', () => old.promise, undefined, owner.signal)
      const joined = store.refresh(
        'fp',
        'grok',
        () => Promise.reject(new Error('must join')),
        undefined,
        joiner.signal
      )
      expect(joined).toBe(listing)
      joiner.abort()
      expect(store.isListing('fp')).toBe(true)
      const readers = [store.pendingListing('fp'), store.pendingListing('fp', true, true)]
      await Promise.resolve()
      owner.abort()
      expect(await Promise.all([listing, joined, ...readers])).toEqual([null, null, null, null])
      const replacement = store.refresh('fp', 'grok', () => next.promise)
      const waiting = store.pendingListing('fp', true, true)
      let settled = false
      void waiting?.then(() => {
        settled = true
      })
      owner.abort()
      if (outcome === 'success') {
        old.resolve(success('old'))
      } else {
        old.reject(new Error('old failure'))
      }
      await Promise.resolve()
      await Promise.resolve()
      expect(store.isListing('fp')).toBe(true)
      expect(settled).toBe(false)
      expect(store.get('fp')).toBeNull()
      expect(store.failure('fp')).toBeNull()
      next.resolve(success('new'))
      expect((await replacement)?.models[0]?.id).toBe('new')
      expect((await waiting)?.models[0]?.id).toBe('new')
    }
  )

  it('ends a picker wait at its deadline even while a listing remains active', async () => {
    vi.useFakeTimers()
    try {
      const store = new AgentModelCatalogStore()
      let settle!: (success: AgentModelCatalogSuccess) => void
      const listing = store.refresh(
        'fp-1',
        'grok',
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

  it('still writes a pending probe that resolves after a live save, keeping both', async () => {
    const store = new AgentModelCatalogStore()
    let settleProbe!: (success: AgentModelCatalogSuccess) => void
    const probe = () => new Promise<AgentModelCatalogSuccess>((resolve) => (settleProbe = resolve))
    const pending = store.refresh('fp-1', 'grok', probe)
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'live')
    await Promise.resolve()
    settleProbe({ ...success('gpt-probe'), origin: 'probe' })
    await pending
    const entry = store.get('fp-1')!
    expect(entry.discovered!.models[0]!.id).toBe('gpt-probe')
    expect(entry.live!.models[0]!.id).toBe('gpt-live')
    // Live reports cannot reset discovery freshness or its failure backoff.
    await store.refresh('fp-1', 'grok', () => Promise.reject(new Error('timed out')))
    store.recordSuccess('fp-1', 'grok', success('gpt-live'), 'live')
    expect(store.hasActiveFailure('fp-1')).toBe(true)
  })

  it('records a failed refresh as a failure and resolves null without rejecting', async () => {
    const store = new AgentModelCatalogStore()
    const entry = await store.refresh('fp-1', 'grok', async () => {
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
    store.recordSuccess('fp', 'grok', { ...listing(), origin: 'probe' }, 'discovery')
    expect(store.get('fp')!.models[0]!.defaultEffort).toBe('medium')
    await store.flushPersistence()
    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(restarted.get('fp')!.models[0]!.defaultEffort).toBe('medium')

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
    await store.refresh('fp-2', 'grok', () => Promise.reject(new Error('timed out')))
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

  it('writes a coalesced save at once when flushed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-model-catalog-'))
    const store = new AgentModelCatalogStore()
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('fp-1', 'grok', success('gpt-a'), 'discovery')
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
