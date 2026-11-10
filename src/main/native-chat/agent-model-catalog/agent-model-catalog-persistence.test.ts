import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createAgentModelCatalogFilePersistence } from './agent-model-catalog-persistence'
import { AgentModelCatalogStore } from './agent-model-catalog-store'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it("imports an older build's catalog file once and keeps later listings", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-model-catalog-'))
  directories.push(directory)
  const legacyPath = join(directory, 'agent-model-catalog.json')
  writeFileSync(
    legacyPath,
    JSON.stringify({
      version: 3,
      entries: [
        {
          agent: 'grok',
          fingerprint: 'fp',
          discovered: {
            origin: 'probe',
            at: 1,
            models: [{ id: 'A', label: 'A', efforts: [], isDefault: true }]
          },
          live: null
        }
      ]
    })
  )
  const store = new AgentModelCatalogStore()
  await store.attachPersistence(createAgentModelCatalogFilePersistence(directory))
  expect(store.get('fp')?.models[0]?.id).toBe('A')
  expect(existsSync(legacyPath)).toBe(false)

  store.recordSuccess(
    'fp',
    'grok',
    { origin: 'probe', models: [{ id: 'B', label: 'B', efforts: [], isDefault: true }] },
    'discovery'
  )
  await store.flushPersistence()

  const restarted = await createAgentModelCatalogFilePersistence(directory).load()
  expect(restarted.map((entry) => entry.models[0]?.id)).toEqual(['B'])
})
