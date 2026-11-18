import { describe, expect, it, vi } from 'vitest'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'

const { readHeader } = vi.hoisted(() => ({
  readHeader: vi.fn(() => ({ format: 'png' as const, width: 256, height: 256 }))
}))
vi.mock('../../../shared/plugins/images/plugin-image-format', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPluginImageHeader: readHeader
}))

import { createCatalogBufferMemo, extractCatalogImages } from './plugin-catalog-image-extraction'
import { sha256Hex } from '../media/plugin-image-cache'

describe('catalog image extraction passes', () => {
  it('scans each image header once across passes that share a memo', async () => {
    const icons = [Buffer.from('icon-a'), Buffer.from('icon-b')]
    const listing = {
      plugins: icons.map((bytes, index) => ({
        releases: [
          {
            images: {
              icon: {
                path: `p${index}/icon.png`,
                sha256: sha256Hex(bytes),
                width: 256,
                height: 256
              }
            }
          }
        ]
      }))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: extraction reads only plugins[].releases[].images; the rest of a listing is irrelevant here.
    const marketplace = listing as unknown as PluginMarketplace
    const readBlob = async (path: string): Promise<Buffer | null> => icons[Number(path[1])] ?? null
    const memo = createCatalogBufferMemo()

    for (let pass = 0; pass < 3; pass++) {
      const { images } = await extractCatalogImages(marketplace, readBlob, undefined, memo)
      expect(images).toEqual(icons)
    }
    expect(readHeader).toHaveBeenCalledTimes(2)
  })
})
