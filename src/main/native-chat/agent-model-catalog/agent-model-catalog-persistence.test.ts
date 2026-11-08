import { mkdtempSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import { AgentModelCatalogStore } from './agent-model-catalog-store'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fsPromises>()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})
await vi.importActual<typeof fsPromises>('node:fs/promises')
afterEach(() => {
  vi.restoreAllMocks()
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
