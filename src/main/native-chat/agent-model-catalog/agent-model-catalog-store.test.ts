import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
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
