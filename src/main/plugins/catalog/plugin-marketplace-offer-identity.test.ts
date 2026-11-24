import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { withMarketplaceInstallEligibility } from './plugin-marketplace-install-eligibility'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceStore } from './plugin-marketplace-store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['unchanged', 'display-only', 'replaced', 'withdrawn'] as const)(
  'guards publication by the offered release identity after a catalog edit (%s)',
  async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-offer-identity-'))
    roots.push(root)
    const store = new PluginMarketplaceStore(root)
    const source = await store.addSource({
      kind: 'git',
      url: 'https://github.com/samples/catalog.git',
      ref: 'main'
    })
    const release = {
      version: '1.0.0',
      commit: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      execution: 'data' as const,
      minimumOrca: '1.4.248'
    }
    const entry = {
      id: 'samples.demo',
      source: { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' },
      categories: [],
      releases: [release]
    }
    const snapshot = {
      source,
      marketplaceCommit: 'c'.repeat(40),
      marketplace: { name: 'Samples', owner: 'samples', plugins: [entry] }
    }
    await store.writeSnapshot(snapshot)
    const marketplace = new PluginMarketplaceService({ pluginsDataDir: root, store })
    const admitted = await marketplace.findPlugin(source.id, entry.id)
    if (!admitted) {
      throw new Error('fixture offer missing')
    }
    await store.writeSnapshot({
      ...snapshot,
      marketplaceCommit: 'd'.repeat(40),
      marketplace: {
        ...snapshot.marketplace,
        plugins:
          change === 'withdrawn'
            ? []
            : [
                {
                  ...entry,
                  releases: [
                    {
                      ...release,
                      ...(change === 'display-only' ? { homepage: 'https://example.org/new' } : {}),
                      ...(change === 'replaced' ? { contentHash: 'e'.repeat(64) } : {})
                    }
                  ]
                }
              ]
      }
    })
    const receipt = join(root, 'published')
    const publish = withMarketplaceInstallEligibility(marketplace, admitted, '1.4.248', () =>
      writeFile(receipt, admitted.release!.contentHash)
    )
    if (change === 'replaced' || change === 'withdrawn') {
      await expect(publish).rejects.toThrow('review the plugin again')
      await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      await publish
      expect(await readFile(receipt, 'utf8')).toBe('b'.repeat(64))
    }
  }
)

it('refuses publication when a refresh raises the release minimum Orca past this build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-offer-minimum-'))
  roots.push(root)
  const store = new PluginMarketplaceStore(root)
  const source = await store.addSource({
    kind: 'git',
    url: 'https://github.com/samples/catalog.git',
    ref: 'main'
  })
  const release = {
    version: '1.0.0',
    commit: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    execution: 'data' as const,
    minimumOrca: '1.4.248'
  }
  const entry = {
    id: 'samples.demo',
    source: { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' },
    categories: [],
    releases: [release]
  }
  const snapshot = {
    source,
    marketplaceCommit: 'c'.repeat(40),
    marketplace: { name: 'Samples', owner: 'samples', plugins: [entry] }
  }
  await store.writeSnapshot(snapshot)
  const marketplace = new PluginMarketplaceService({ pluginsDataDir: root, store })
  const admitted = await marketplace.findPlugin(source.id, entry.id)
  if (!admitted) {
    throw new Error('fixture offer missing')
  }
  // Why: a refresh that keeps the offered bytes but raises the minimum must still stop the write.
  await store.writeSnapshot({
    ...snapshot,
    marketplaceCommit: 'd'.repeat(40),
    marketplace: {
      ...snapshot.marketplace,
      plugins: [{ ...entry, releases: [{ ...release, minimumOrca: '1.5.0' }] }]
    }
  })
  const receipt = join(root, 'published')
  const publish = withMarketplaceInstallEligibility(marketplace, admitted, '1.4.248', () =>
    writeFile(receipt, admitted.release!.contentHash)
  )
  await expect(publish).rejects.toThrow('requires Orca >=1.5.0 (this is 1.4.248)')
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
})
