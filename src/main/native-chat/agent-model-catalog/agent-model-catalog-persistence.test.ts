import { mkdtempSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import {
  AgentModelCatalogStore,
  AGENT_MODEL_CATALOG_MAX_ENTRIES
} from './agent-model-catalog-store'
import type { AgentModelCatalogEntry } from './agent-model-catalog-entry'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fsPromises>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})
const actual = await vi.importActual<typeof fsPromises>('node:fs/promises')
afterEach(() => {
  vi.restoreAllMocks()
})

it('materializes once per flush, freezes A before queued B, and returns the no-pending writing barrier', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-31927-catalog-snapshot-'))
  const persistence = createAgentModelCatalogFilePersistence(directory)
  const store = new AgentModelCatalogStore()
  let materializations = 0
  await store.attachPersistence({
    ...persistence,
    save: (snapshot) =>
      persistence.save(() => {
        materializations++
        return snapshot()
      })
  })
  const publish = (id: string) =>
    store.recordSuccess(
      'fp',
      'grok',
      {
        origin: 'probe',
        models: [{ id, label: id, efforts: [], isDefault: true }]
      },
      'discovery'
    )
  for (let index = 0; index < 10; index++) {
    publish(`burst-${index}`)
  }
  publish('A')
  store.recordConfiguredDefault('fp', { modelId: 'A', effort: 'high' })
  expect(materializations).toBe(0)
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  vi.mocked(fsPromises.writeFile).mockImplementationOnce(async (...args) => {
    entered.resolve()
    await held.promise
    await actual.writeFile(...args)
  })
  const a = persistence.flush()
  expect(materializations).toBe(1)
  await entered.promise
  publish('B')
  const b = persistence.flush()
  expect(materializations).toBe(2)
  expect(persistence.flush()).toBe(b)
  expect(materializations).toBe(2)
  expect(fsPromises.writeFile).toHaveBeenCalledTimes(1)
  held.resolve()
  await a
  await b
  const writes = vi.mocked(fsPromises.writeFile).mock.calls
  expect(writes[0]?.[1]).toContain('"id":"A"')
  expect(writes[0]?.[1]).not.toContain('"id":"B"')
  expect(writes[1]?.[1]).toContain('"id":"B"')
  expect(
    JSON.parse(await fsPromises.readFile(join(directory, 'agent-model-catalog.json'), 'utf8'))
      .version
  ).toBe(3)
  const reloaded = new AgentModelCatalogStore()
  await reloaded.attachPersistence(createAgentModelCatalogFilePersistence(directory))
  expect(reloaded.get('fp')).toMatchObject({
    discovered: { models: [{ id: 'B' }] },
    configured: { modelId: 'A', effort: 'high' }
  })
  // Explicit quit-style flush materializes pending work without the unref'd timer firing.
  publish('quit')
  await store.flushPersistence()
  expect(materializations).toBe(3)
  expect((await persistence.load())[0]?.models[0]?.id).toBe('quit')
})

it('captures committed hydration, cap, timestamps and LRU order at flush without arming reads', async () => {
  let now = 1
  const directory = mkdtempSync(join(tmpdir(), 'pr-31927-catalog-hydration-'))
  const persistence = createAgentModelCatalogFilePersistence(directory)
  const store = new AgentModelCatalogStore({ now: () => now })
  const loaded = Promise.withResolvers<AgentModelCatalogEntry[]>()
  const attach = store.attachPersistence({ ...persistence, load: () => loaded.promise })
  const publish = (key: string) =>
    store.recordSuccess(
      key,
      'grok',
      {
        origin: 'probe',
        models: [{ id: key, label: key, efforts: [], isDefault: true }]
      },
      'discovery'
    )!
  const hydrated = new AgentModelCatalogStore()
  const rows = Array.from({ length: AGENT_MODEL_CATALOG_MAX_ENTRIES }, (_, index) =>
    hydrated.recordSuccess(
      `saved-${index}`,
      'grok',
      {
        origin: 'probe',
        models: [{ id: 'saved', label: 'Saved', efforts: [], isDefault: true }]
      },
      'discovery'
    )!
  )
  publish('current')
  now = 2
  publish('current') // Same content updates age, but does not request another save.
  loaded.resolve(rows)
  await attach
  expect(store.get('current')).toBeNull()
  now = 3
  store.recordSuccess(
    'saved-1',
    'grok',
    { origin: 'probe', models: [{ id: 'saved', label: 'Saved', efforts: [], isDefault: true }] },
    'discovery'
  )
  store.get('saved-1')
  await store.flushPersistence()
  const saved = await persistence.load()
  expect(saved).toHaveLength(AGENT_MODEL_CATALOG_MAX_ENTRIES)
  expect(saved.at(-1)?.fingerprint).toBe('saved-1')
  expect(saved.at(-1)?.discovered?.at).toBe(3)
  expect(saved.some((entry) => entry.fingerprint === 'current')).toBe(false)
  const writes = vi.mocked(fsPromises.writeFile).mock.calls.length
  store.get('saved-2')
  await store.flushPersistence()
  expect(fsPromises.writeFile).toHaveBeenCalledTimes(writes)
})

it('keeps optional cache write failure from poisoning subsequent serialized writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pr-31927-catalog-failure-'))
  const store = new AgentModelCatalogStore()
  const persistence = createAgentModelCatalogFilePersistence(directory)
  await store.attachPersistence(persistence)
  const publish = (id: string) =>
    store.recordSuccess(
      'fp',
      'grok',
      {
        origin: 'probe',
        models: [{ id, label: id, efforts: [], isDefault: true }]
      },
      'discovery'
    )
  vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error('cache unavailable'))
  publish('A')
  await store.flushPersistence()
  expect(store.get('fp')?.models[0]?.id).toBe('A')
  publish('B')
  await store.flushPersistence()
  expect((await persistence.load())[0]?.models[0]?.id).toBe('B')
})
