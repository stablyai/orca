import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { withMarketplaceInstallEligibility } from './plugin-marketplace-install-eligibility'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceStore } from './plugin-marketplace-store'

const roots: string[] = []

/** The release the fixture admits, and the manifest a fresh install of its bytes reads. */
const RELEASE: {
  version: string
  commit: string
  contentHash: string
  execution: 'data' | 'declarative'
  minimumOrca: string
} = {
  version: '1.0.0',
  commit: 'a'.repeat(40),
  contentHash: 'b'.repeat(64),
  execution: 'data',
  minimumOrca: '1.4.248'
}

function stagedManifest(execution: 'data' | 'declarative' = 'data') {
  return pluginManifestSchema.parse({
    manifestVersion: 2,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: RELEASE.version,
    execution,
    license: 'MIT',
    engines: { orca: `>=${RELEASE.minimumOrca}` },
    capabilities: [],
    contributes: {}
  })
}

/** Admits RELEASE from a catalog, then lets a refresh replace it with `refreshed`. */
async function refreshedOffer(refreshed: typeof RELEASE) {
  const root = await mkdtemp(join(tmpdir(), 'orca-offer-requirements-'))
  roots.push(root)
  const store = new PluginMarketplaceStore(root)
  const source = await store.addSource({
    kind: 'git',
    url: 'https://github.com/samples/catalog.git',
    ref: 'main'
  })
  const entry = {
    id: 'samples.demo',
    source: { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' },
    categories: [],
    releases: [RELEASE]
  }
  const marketplace = new PluginMarketplaceService({ pluginsDataDir: root, store })
  await store.writeSnapshot({
    source,
    marketplaceCommit: 'c'.repeat(40),
    marketplace: { name: 'Samples', owner: 'samples', plugins: [entry] }
  })
  const admitted = await marketplace.findPlugin(source.id, entry.id)
  if (!admitted) {
    throw new Error('fixture offer missing')
  }
  await store.writeSnapshot({
    source,
    marketplaceCommit: 'd'.repeat(40),
    marketplace: {
      name: 'Samples',
      owner: 'samples',
      plugins: [{ ...entry, releases: [refreshed] }]
    }
  })
  return { root, marketplace, admitted }
}
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
    const publish = withMarketplaceInstallEligibility(
      marketplace,
      admitted,
      { hostVersion: '1.4.248', manifest: stagedManifest() },
      () => writeFile(receipt, admitted.release!.contentHash)
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
  const publish = withMarketplaceInstallEligibility(
    marketplace,
    admitted,
    { hostVersion: '1.4.248', manifest: stagedManifest() },
    () => writeFile(receipt, admitted.release!.contentHash)
  )
  await expect(publish).rejects.toThrow('requires Orca >=1.5.0 (this is 1.4.248)')
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses publication when a refresh changes the execution assertion of the same bytes', async () => {
  const { root, marketplace, admitted } = await refreshedOffer({
    ...RELEASE,
    execution: 'declarative'
  })
  const receipt = join(root, 'published')
  const publish = withMarketplaceInstallEligibility(
    marketplace,
    admitted,
    { hostVersion: '1.4.248', manifest: stagedManifest('data') },
    () => writeFile(receipt, RELEASE.contentHash)
  )
  // Why: a fresh install of these bytes reads `data` and rejects the refreshed `declarative` claim.
  await expect(publish).rejects.toThrow(
    'marketplace changed after preview; review the plugin again: execution profile does not match the catalog release'
  )
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses publication when a refresh lowers the minimum Orca to one this host still satisfies', async () => {
  const { root, marketplace, admitted } = await refreshedOffer({
    ...RELEASE,
    minimumOrca: '1.4.200'
  })
  const receipt = join(root, 'published')
  const publish = withMarketplaceInstallEligibility(
    marketplace,
    admitted,
    { hostVersion: '1.4.248', manifest: stagedManifest() },
    () => writeFile(receipt, RELEASE.contentHash)
  )
  // Why: 1.4.248 meets >=1.4.200, but the staged manifest declares >=1.4.248, which a fresh install rejects.
  await expect(publish).rejects.toThrow(
    'marketplace changed after preview; review the plugin again: Orca compatibility does not match the catalog release'
  )
  await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
})
