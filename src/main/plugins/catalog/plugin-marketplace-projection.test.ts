import { describe, expect, it } from 'vitest'
import { pluginCatalogReleaseSchema } from '../../../shared/plugins/catalog/plugin-catalog-release'
import { pluginCatalogListingDetails } from './plugin-marketplace-projection'

describe('pluginCatalogListingDetails', () => {
  it('flattens the display fields a release carries', () => {
    const release = pluginCatalogReleaseSchema.parse({
      version: '1.2.0',
      commit: 'c'.repeat(40),
      contentHash: 'f'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.0',
      types: ['app-theme'],
      name: 'Orca Midnight',
      license: 'MIT',
      updatedAt: '2026-10-20',
      changelog: 'Warmer comments.'
    })
    expect(pluginCatalogListingDetails(release)).toEqual({
      name: 'Orca Midnight',
      version: '1.2.0',
      license: 'MIT',
      updatedAt: '2026-10-20',
      changelog: 'Warmer comments.'
    })
    expect(pluginCatalogListingDetails(undefined)).toEqual({})
  })
})
