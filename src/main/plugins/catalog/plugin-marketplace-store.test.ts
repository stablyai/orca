import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogImageFixture, pngImageBytes } from '../media/plugin-image-test-fixture'
import { readMarketplaceSnapshots } from './plugin-marketplace-snapshots'
import type { PluginMarketplaceGitSource } from '../../../shared/plugins/catalog/plugin-marketplace'
import { PluginMarketplaceStore } from './plugin-marketplace-store'

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

function pluginsWithReleases(count: number) {
  const cover = catalogImageFixture('cover.png', pngImageBytes(1600, 1000))
  const releases = Array.from({ length: 32 }, (_, index) => ({
    version: `1.0.${index}`,
    commit: 'c'.repeat(40),
    contentHash: 'f'.repeat(64),
    execution: 'data' as const,
    minimumOrca: '1.4.0',
    changelog: 'a'.repeat(2_000),
    images: { cover }
  }))
  return Array.from({ length: count }, (_, index) => ({
    id: `community.plugin-${index}`,
    source: source(),
    categories: [],
    releases
  }))
}

describe('PluginMarketplaceStore', () => {
  it('reopens a release-heavy catalog whose compact snapshot fits the read limit', async () => {
    const root = await tempRoot()
    const store = new PluginMarketplaceStore(root)
    const registered = await store.addSource(source())
    await store.writeSnapshot({
      source: registered,
      marketplaceCommit: 'b'.repeat(40),
      marketplace: { name: 'Community', owner: 'community', plugins: pluginsWithReleases(205) }
    })

    const snapshot = await new PluginMarketplaceStore(root).readSnapshot(registered.id)
    expect(snapshot?.marketplace.plugins.at(-1)).toMatchObject({
      id: 'community.plugin-204',
      releases: expect.arrayContaining([expect.objectContaining({ version: '1.0.31' })])
    })
  })

  it('keeps the previous readable snapshot when the replacement exceeds the read limit', async () => {
    const root = await tempRoot()
    const store = new PluginMarketplaceStore(root)
    const registered = await store.addSource(source())
    const listing = { name: 'Community', owner: 'community', plugins: [] }
    const previous = await store.writeSnapshot({
      source: registered,
      marketplaceCommit: 'a'.repeat(40),
      marketplace: listing
    })

    await expect(
      store.writeSnapshot({
        source: registered,
        marketplaceCommit: 'b'.repeat(40),
        marketplace: { ...listing, plugins: pluginsWithReleases(260) }
      })
    ).rejects.toThrow('marketplace snapshot exceeds its size limit')
    await expect(new PluginMarketplaceStore(root).readSnapshot(registered.id)).resolves.toEqual(
      previous
    )
  })
  it('lists healthy sources when a snapshot written by an older build is unreadable', async () => {
    const root = await tempRoot()
    const store = new PluginMarketplaceStore(root)
    const failed = await store.addSource(source('broken'))
    const healthy = await store.addSource(source('healthy'))
    const snapshot = await store.writeSnapshot({
      source: healthy,
      marketplaceCommit: 'a'.repeat(40),
      marketplace: { name: 'Community', owner: 'community', plugins: [] }
    })
    await writeFile(join(root, 'marketplaces', 'snapshots', `${failed.id}.v2.json`), '{')
    await expect(readMarketplaceSnapshots(store, await store.listSources())).resolves.toEqual([
      { source: healthy, snapshot }
    ])
  })
})
