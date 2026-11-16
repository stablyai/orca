import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import { expireAgentModelCatalogFailuresForSettings } from './agent-model-catalog-account-expiry'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'

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
  it('invalidates changed inputs only, retaining rows and incomplete evidence until rediscovery', async () => {
    let now = 0
    const store = new AgentModelCatalogStore({ now: () => now })
    store.observeInputs('a', 'install-1')
    store.recordSuccess(
      'a',
      'claude',
      { ...success('opus'), origin: 'probe', complete: false },
      'discovery'
    )
    store.recordSuccess(
      'b',
      'codex',
      { ...success('gpt'), origin: 'probe', complete: true },
      'discovery'
    )
    now = 13 * 60 * 60_000
    store.refreshInputs(false)
    expect(store.probeDue('a')).toBe(false)
    expect(store.verified(store.get('a')!)).toBe(false)
    expect(store.probeDue('b')).toBe(false)
    store.observeInputs('a', 'install-2')
    expect(store.probeDue('a')).toBe(true)
    expect(store.get('a')?.models[0]?.id).toBe('opus')
    expect(store.probeDue('b')).toBe(false)
    expect(store.retirementRevision('claude')).toBe(0)
    await store.refresh('a', 'claude', async () => {
      throw new Error('network unavailable')
    })
    expect(store.probeDue('a')).toBe(false)
    now += 30_001
    expect(store.probeDue('a')).toBe(true)
    expect(store.get('a')?.models[0]?.id).toBe('opus')
    await store.refresh('a', 'claude', async () => ({
      ...success('sonnet'),
      origin: 'probe',
      complete: true
    }))
    now += 13 * 60 * 60_000
    expect(store.probeDue('a')).toBe(false)
    expect(store.get('a')?.models[0]?.id).toBe('sonnet')
    store.refreshInputs(true)
    expect(store.probeDue('a')).toBe(true)
    expect(store.probeDue('b')).toBe(true)
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
})

it('requires validation when a retained catalog has lost its bounded input baseline', () => {
  const store = new AgentModelCatalogStore()
  for (let index = 0; index < 256; index++) {
    store.observeInputs(String(index), 'original')
    store.recordSuccess(String(index), 'grok', success('old'), 'discovery')
  }
  store.get('0')
  store.observeInputs('256', 'original')
  store.recordSuccess('256', 'grok', success('new'), 'discovery')
  store.observeInputs('0', 'replacement')
  expect(store.probeDue('0')).toBe(true)
  expect(store.get('0')?.models[0]?.id).toBe('old')
  store.observeInputs('2', 'original')
  expect(store.probeDue('2')).toBe(false)
})

it('requires new account evidence after same-home reauthentication while preserving other agents', async () => {
  const store = new AgentModelCatalogStore()
  for (const agent of ['claude', 'codex', 'grok']) {
    store.recordSuccess(agent, agent, { ...success('old'), complete: true }, 'discovery')
  }
  const stale = Promise.withResolvers<AgentModelCatalogSuccess>()
  const flight = store.refresh('claude', 'claude', () => stale.promise)
  await Promise.resolve()
  expireAgentModelCatalogFailuresForSettings(store, { claudeManagedAccounts: [] })
  expect(store.probeDue('claude')).toBe(true)
  expect(store.get('claude')?.models[0]?.id).toBe('old')
  expect(store.probeDue('codex')).toBe(false)
  expect(store.probeDue('grok')).toBe(false)
  stale.resolve(success('wrong-account'))
  await flight
  await Promise.resolve()
  expect(store.get('claude')?.models[0]?.id).toBe('old')
  await store.refresh('claude', 'claude', async () => ({
    ...success('new-account'),
    complete: true
  }))
  expect(store.get('claude')?.models[0]?.id).toBe('new-account')
})
