import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'

import { extractCatalogImages } from './plugin-catalog-image-extraction'

const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function png(width: number, height: number, bytes: number): Buffer {
  const ihdr = [...Buffer.from('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]
  const header = Buffer.from([
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
    0,
    0,
    0,
    0,
    0,
    0x49,
    0x45,
    0x4e,
    0x44,
    0,
    0,
    0,
    0
  ])
  const image = Buffer.alloc(bytes)
  header.copy(image)
  return image
}

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function image(path: string, bytes: Buffer, width: number, height: number) {
  return { path, alt: path, sha256: sha(bytes), width, height }
}

function plugin(id: string, images: Record<string, unknown>) {
  return {
    id,
    source: {
      kind: 'git' as const,
      url: 'https://github.com/example/plugins.git',
      ref: 'main'
    },
    categories: ['themes'],
    releases: [
      {
        version: '1.0.0',
        commit: 'c'.repeat(40),
        contentHash: 'f'.repeat(64),
        execution: 'data' as const,
        minimumOrca: '1.4.245',
        images
      }
    ]
  }
}

function marketplace(plugins: PluginMarketplace['plugins']): PluginMarketplace {
  return { name: 'Community', owner: 'example', plugins }
}

const coverBytes = png(800, 500, 40_000)
const iconBytes = png(128, 128, 20_000)
const shotBytes = png(1280, 800, 50_000)
const files = new Map<string, Buffer>([
  ['early/shot.png', shotBytes],
  ['late/cover.png', coverBytes],
  ['late/icon.png', iconBytes]
])
const read = async (path: string, maxBytes: number): Promise<Buffer | null> => {
  const bytes = files.get(path)
  return bytes && bytes.byteLength <= maxBytes ? bytes : null
}
const catalog = marketplace([
  plugin('alpha.early', {
    screenshots: [image('early/shot.png', shotBytes, 1280, 800)]
  }),
  plugin('zeta.late', {
    icon: image('late/icon.png', iconBytes, 128, 128),
    cover: image('late/cover.png', coverBytes, 800, 500)
  })
])

describe('extractCatalogImages', () => {
  it('keeps a later cover and icon when an earlier screenshot would spend the image budget', async () => {
    const extracted = await extractCatalogImages(catalog, read, undefined, {
      maxImageBytes: 60_000
    })
    expect(extracted.marketplace.plugins[0]?.releases?.[0]?.images).toBeUndefined()
    expect(extracted.marketplace.plugins[1]?.releases?.[0]?.images).toEqual({
      icon: image('late/icon.png', iconBytes, 128, 128),
      cover: image('late/cover.png', coverBytes, 800, 500)
    })
  })

  it('still keeps a screenshot when the cover and icon leave room in the budget', async () => {
    const extracted = await extractCatalogImages(catalog, read, undefined, {
      maxImageBytes: 120_000
    })
    expect(extracted.marketplace.plugins[0]?.releases?.[0]?.images?.screenshots).toEqual([
      image('early/shot.png', shotBytes, 1280, 800)
    ])
    expect(extracted.marketplace.plugins[1]?.releases?.[0]?.images).toEqual({
      icon: image('late/icon.png', iconBytes, 128, 128),
      cover: image('late/cover.png', coverBytes, 800, 500)
    })
  })
})
