import { describe, expect, it } from 'vitest'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'
import { extractCatalogImages } from './plugin-catalog-image-extraction'
import { catalogImageFixture, pngImageBytes } from '../media/plugin-image-test-fixture'

function catalog(count: number): PluginMarketplace {
  return {
    name: 'Catalog',
    owner: 'acme',
    plugins: Array.from({ length: count }, (_, n) => ({
      id: `acme.plugin-${n}`,
      source: { kind: 'git', url: 'https://github.com/acme/plugin.git', ref: 'main' },
      categories: ['themes'],
      releases: [
        {
          version: '1.0.0',
          minimumOrca: '1.4.0',
          execution: 'data',
          commit: 'a'.repeat(40),
          contentHash: 'b'.repeat(64),
          images: {
            cover: catalogImageFixture(`covers/${n}.png`, pngImageBytes(1600, 1000, 1024 * 1024, n))
          }
        }
      ]
    }))
  }
}

const readCover = async (path: string, maxBytes: number): Promise<Buffer | null> =>
  maxBytes < 1024 * 1024
    ? null
    : pngImageBytes(1600, 1000, 1024 * 1024, Number(path.split('/')[1]?.split('.')[0]))

describe('catalog image references', () => {
  it('retains all 300 one-MiB covers when on-demand reads are available', async () => {
    const result = await extractCatalogImages(catalog(300), readCover, undefined, undefined, true)
    expect(
      result.marketplace.plugins.filter((entry) => entry.releases?.[0]?.images?.cover)
    ).toHaveLength(300)
    expect(result.marketplace.plugins[299]?.releases?.[0]?.images?.cover?.path).toBe(
      'covers/299.png'
    )
  })

  it('drops references whose bytes were read and fail their declared dimensions', async () => {
    const listing = catalog(1)
    listing.plugins[0]!.releases![0]!.images!.cover!.width = 1280
    const result = await extractCatalogImages(listing, readCover, undefined, undefined, true)
    expect(result.marketplace.plugins[0]?.releases?.[0]?.images).toBeUndefined()
  })
})
