import { describe, expect, it } from 'vitest'
import { pluginCatalogReleaseSchema } from '../../../shared/plugins/catalog/plugin-catalog-release'
import type { PluginMarketplaceEntry } from '../../../shared/plugins/catalog/plugin-marketplace'
import { pluginMarketplaceListing } from './plugin-marketplace-projection'
import type {
  PluginMarketplaceCachedSnapshot,
  PluginMarketplaceRegisteredSource
} from './plugin-marketplace-store'

function release(version: string, updatedAt?: string) {
  return pluginCatalogReleaseSchema.parse({
    version,
    commit: 'a'.repeat(40),
    contentHash: 'b'.repeat(64),
    execution: 'data',
    minimumOrca: '1.4.0',
    types: ['app-theme'],
    ...(updatedAt ? { updatedAt } : {})
  })
}

function listing(catalogRepo: string, entry: PluginMarketplaceEntry) {
  const source: PluginMarketplaceRegisteredSource = {
    id: 'catalog',
    source: { kind: 'git', url: `https://github.com/stablyai/${catalogRepo}.git`, ref: 'main' },
    addedAt: 1
  }
  const snapshot: PluginMarketplaceCachedSnapshot = {
    schemaVersion: 2,
    sourceId: 'catalog',
    source: source.source,
    marketplaceCommit: 'c'.repeat(40),
    fetchedAt: 1,
    marketplace: { name: catalogRepo, owner: 'stablyai', plugins: [entry] }
  }
  return pluginMarketplaceListing({ source, snapshot, entry, hostVersion: null, blocked: null })
}

function entry(
  owner: string,
  releases: PluginMarketplaceEntry['releases']
): PluginMarketplaceEntry {
  const value: PluginMarketplaceEntry = {
    id: `${owner}.notes`,
    source: { kind: 'git', url: `https://github.com/${owner}/notes.git`, ref: 'main' },
    categories: ['themes'],
    releases
  }
  return value
}

describe('pluginMarketplaceListing addedAt', () => {
  it("estimates a community plugin's listing date from its oldest dated release", () => {
    const projected = listing(
      'orca-community-plugins',
      entry('acme', [
        release('1.1.0', '2026-11-08T09:00:00Z'),
        release('1.0.0', '2026-11-02T09:00:00+02:00')
      ])
    )
    expect(projected.official).toBe(false)
    expect(projected.addedAt).toBe('2026-11-02T07:00:00.000Z')
  })

  it('leaves official and undated plugins without one', () => {
    const official = listing(
      'orca-plugins',
      entry('stablyai', [release('1.0.0', '2026-11-02T09:00:00Z')])
    )
    expect(official.official).toBe(true)
    expect(official).not.toHaveProperty('addedAt')
    expect(listing('orca-community-plugins', entry('acme', [release('1.0.0')]))).not.toHaveProperty(
      'addedAt'
    )
  })
})
