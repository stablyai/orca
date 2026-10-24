import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginMarketplaceGitSource } from '../../shared/plugins/plugin-marketplace'
import { marketplaceSourceId, PluginMarketplaceStore } from './plugin-marketplace-store'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-store-'))
  roots.push(root)
  return root
}

function source(ref = 'main'): PluginMarketplaceGitSource {
  return { kind: 'git', url: 'https://github.com/community/plugins.git', ref }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginMarketplaceStore', () => {
  it('persists bounded source registrations under a deterministic opaque id', async () => {
    const root = await tempRoot()
    const first = new PluginMarketplaceStore(root)
    const registered = await first.addSource(source(), 123)

    expect(registered).toEqual({
      id: marketplaceSourceId(source()),
      source: source(),
      addedAt: 123
    })
    await expect(new PluginMarketplaceStore(root).listSources()).resolves.toEqual([registered])
    await expect(first.addSource(source(), 999)).resolves.toEqual(registered)
  })

  it('atomically publishes a strict cached snapshot and removes it with its source', async () => {
    const root = await tempRoot()
    const store = new PluginMarketplaceStore(root)
    const registered = await store.addSource(source(), 123)
    const snapshot = await store.writeSnapshot({
      source: registered,
      marketplaceCommit: 'a'.repeat(40),
      fetchedAt: 456,
      marketplace: {
        name: 'Community',
        owner: 'community',
        plugins: [
          {
            id: 'community.theme',
            source: {
              kind: 'git',
              url: 'https://github.com/community/theme.git',
              ref: 'v1'
            },
            categories: ['themes']
          }
        ]
      }
    })

    await expect(new PluginMarketplaceStore(root).readSnapshot(registered.id)).resolves.toEqual(
      snapshot
    )
    expect(
      (await readdir(join(root, 'marketplaces', 'snapshots'))).filter((entry) =>
        entry.endsWith('.tmp')
      )
    ).toEqual([])
    await expect(store.removeSource(registered.id)).resolves.toBe(true)
    await expect(store.readSnapshot(registered.id)).resolves.toBeNull()
  })

  it('keeps distinct refs as distinct marketplace sources', () => {
    expect(marketplaceSourceId(source('main'))).not.toBe(marketplaceSourceId(source('stable')))
  })

  it('rejects path-like source ids before reading or deleting cache files', async () => {
    const store = new PluginMarketplaceStore(await tempRoot())
    await expect(store.readSnapshot('../outside')).rejects.toThrow()
    await expect(store.removeSource('../outside')).rejects.toThrow()
  })

  it('keeps release-bearing snapshots out of the key older builds read', async () => {
    const root = await tempRoot()
    const store = new PluginMarketplaceStore(root)
    const registered = await store.addSource(source(), 123)
    const snapshots = join(root, 'marketplaces', 'snapshots')
    const legacy = {
      schemaVersion: 1,
      sourceId: registered.id,
      source: source(),
      marketplaceCommit: 'a'.repeat(40),
      fetchedAt: 1,
      marketplace: { name: 'Old', owner: 'community', plugins: [] }
    }
    await mkdir(snapshots, { recursive: true })
    await writeFile(join(snapshots, `${registered.id}.json`), JSON.stringify(legacy))
    await expect(store.readSnapshot(registered.id)).resolves.toEqual(legacy)

    await store.writeSnapshot({
      source: registered,
      marketplaceCommit: 'b'.repeat(40),
      marketplace: {
        name: 'New',
        owner: 'community',
        plugins: [
          {
            id: 'community.notes',
            source: { kind: 'git', url: 'https://github.com/community/notes.git', ref: 'v1' },
            categories: [],
            release: {
              version: '1.0.0',
              commit: 'c'.repeat(40),
              contentHash: 'f'.repeat(64),
              execution: 'data',
              minimumOrca: '1.4.0',
              types: ['interface-language']
            }
          }
        ]
      }
    })

    await expect(store.readSnapshot(registered.id)).resolves.toMatchObject({
      marketplace: { name: 'New' }
    })
    // An older build reads only `<id>.json`, which still holds v1-shaped data it can parse.
    expect(JSON.parse(await readFile(join(snapshots, `${registered.id}.json`), 'utf8'))).toEqual(
      legacy
    )
    await store.removeSource(registered.id)
    expect(await readdir(snapshots)).toEqual([])
  })
})
