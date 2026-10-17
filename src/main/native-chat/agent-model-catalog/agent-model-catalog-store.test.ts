import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  AgentModelCatalogStore,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'

const listing = (id = 'opus'): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: [
    {
      id,
      label: id,
      resolvedModel: 'provider-model',
      isDefault: true,
      efforts: [],
      effortsKnown: false
    }
  ],
  configured: { model: 'provider-model', effort: 'high' }
})

it('joins by scope, invalidates absence after failure and never verifies disk data', async () => {
  let now = 10
  const store = new AgentModelCatalogStore({ now: () => now })
  let finish: (value: AgentModelCatalogSuccess) => void = () => {}
  const run = vi.fn(
    () =>
      new Promise<AgentModelCatalogSuccess>((resolve) => {
        finish = resolve
      })
  )
  const first = store.refresh('scope', 'claude', async () => listing(), run)
  expect(store.refresh('scope', 'claude', async () => listing('other'), run)).toBe(first)
  finish(listing())
  const entry = (await first)!
  expect(run).toHaveBeenCalledTimes(1)
  expect(store.freshForMs(entry)).toBe(AGENT_MODEL_CATALOG_FRESH_MS)
  await store.refresh(
    'scope',
    'claude',
    async () => listing(),
    async () => {
      throw new Error('offline')
    }
  )
  now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
  expect(store.get('scope')?.models).toEqual(entry.models)
  expect(store.freshForMs(entry)).toBe(0)
  const directory = await mkdtemp(join(tmpdir(), 'orca-catalog-scope-'))
  try {
    await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    store.recordSuccess('scope', 'claude', listing('refreshed'), 'discovery')
    await store.flushPersistence()
    const loaded = new AgentModelCatalogStore({ now: () => now })
    await loaded.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    expect(loaded.get('scope')?.observation.configured).toEqual(listing().configured)
    expect(loaded.get('scope')?.models).toEqual(listing('refreshed').models)
    expect(loaded.freshForMs(loaded.get('scope')!)).toBe(0)
    expect(loaded.shouldRefresh('scope')).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
