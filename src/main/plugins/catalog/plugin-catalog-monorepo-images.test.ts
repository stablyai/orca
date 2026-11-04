import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'
import { extractCatalogImages } from './plugin-catalog-image-extraction'
import { fillMonorepoReleaseImages } from './plugin-catalog-monorepo-images'

const CATALOG_URL = 'https://github.com/stablyai/orca-plugins.git'
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function png(width: number, height: number): Buffer {
  const ihdr = [...Buffer.from('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    ...ihdr,
    0,
    0,
    0,
    0
  ])
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function catalog(url: string, images?: Record<string, unknown>): PluginMarketplace {
  return {
    name: 'Official',
    owner: 'stablyai',
    plugins: [
      {
        id: 'stablyai.orca-midnight-theme',
        source: { kind: 'git', url, ref: 'main', path: 'plugins/midnight-theme' },
        categories: ['themes'],
        releases: [
          {
            version: '2.1.0',
            commit: 'c'.repeat(40),
            contentHash: 'f'.repeat(64),
            execution: 'data',
            minimumOrca: '1.4.245',
            ...(images ? { images } : {})
          }
        ]
      }
    ]
  }
}

const cover = png(1600, 1000)
const manifest = {
  name: 'Orca Midnight',
  cover: { path: 'images/cover.png', alt: 'Midnight on the editor' },
  screenshots: [{ path: 'images/missing.png', alt: 'Gone' }]
}
const files: Record<string, Buffer> = {
  'plugins/midnight-theme/orca-plugin.json': Buffer.from(JSON.stringify(manifest)),
  'plugins/midnight-theme/images/cover.png': cover
}
const read = async (path: string): Promise<Buffer | null> => files[path] ?? null

describe('fillMonorepoReleaseImages', () => {
  it('lists the manifest cover for a same-repository release published without images', async () => {
    const filled = await fillMonorepoReleaseImages(catalog(CATALOG_URL), CATALOG_URL, read)
    const extracted = await extractCatalogImages(filled, read)
    expect(extracted.marketplace.plugins[0]?.releases?.[0]?.images).toEqual({
      cover: {
        path: 'plugins/midnight-theme/images/cover.png',
        alt: 'Midnight on the editor',
        sha256: sha(cover),
        width: 1600,
        height: 1000
      }
    })
    expect(extracted.images).toEqual([cover])
  })

  it('leaves plugins hosted elsewhere and releases that declare images untouched', async () => {
    const elsewhere = catalog('https://github.com/acme/midnight.git')
    expect(await fillMonorepoReleaseImages(elsewhere, CATALOG_URL, read)).toEqual(elsewhere)
    const declared = catalog(CATALOG_URL, {})
    expect(await fillMonorepoReleaseImages(declared, CATALOG_URL, read)).toEqual(declared)
  })
})
