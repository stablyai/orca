import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'
import { extractCatalogImages } from './plugin-catalog-image-extraction'

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

function image(path: string, bytes: Buffer, width: number, height: number) {
  return { path, alt: path, sha256: sha(bytes), width, height }
}

const fills = [
  {
    id: 'aaa.plugin',
    icon: png(128, 128),
    cover: png(800, 500),
    shot: png(1280, 800),
    iconSize: [128, 128],
    coverSize: [800, 500],
    shotSize: [1280, 800]
  },
  {
    id: 'bbb.plugin',
    icon: png(129, 129),
    cover: png(801, 500),
    shot: png(1281, 800),
    iconSize: [129, 129],
    coverSize: [801, 500],
    shotSize: [1281, 800]
  },
  {
    id: 'ccc.plugin',
    icon: png(130, 130),
    cover: png(802, 500),
    shot: png(1282, 800),
    iconSize: [130, 130],
    coverSize: [802, 500],
    shotSize: [1282, 800]
  }
]

const marketplace: PluginMarketplace = {
  name: 'Official',
  owner: 'stablyai',
  plugins: fills.map((fill) => ({
    id: fill.id,
    source: { kind: 'git', url: 'https://github.com/acme/plugins.git', ref: 'main' },
    categories: ['themes'],
    releases: [
      {
        version: '1.0.0',
        commit: 'c'.repeat(40),
        contentHash: 'f'.repeat(64),
        execution: 'data',
        minimumOrca: '1.4.245',
        images: {
          icon: image(`${fill.id}/icon.png`, fill.icon, fill.iconSize[0]!, fill.iconSize[1]!),
          cover: image(`${fill.id}/cover.png`, fill.cover, fill.coverSize[0]!, fill.coverSize[1]!),
          screenshots: [
            image(`${fill.id}/shot.png`, fill.shot, fill.shotSize[0]!, fill.shotSize[1]!)
          ]
        }
      }
    ]
  }))
}

const files = new Map<string, Buffer>()
for (const fill of fills) {
  files.set(`${fill.id}/icon.png`, fill.icon)
  files.set(`${fill.id}/cover.png`, fill.cover)
  files.set(`${fill.id}/shot.png`, fill.shot)
}

describe('extractCatalogImages budget fairness', () => {
  it('keeps every listed cover before spending the remaining budget on screenshots', async () => {
    // Seven images fit: three icons, three covers, then one screenshot.
    const icon = fills[0]!.icon
    const extracted = await extractCatalogImages(
      marketplace,
      async (path) => files.get(path) ?? null,
      undefined,
      { maxBytes: icon.byteLength * 7 }
    )

    const images = extracted.marketplace.plugins.map((plugin) => plugin.releases?.[0]?.images)
    expect(images.map((entry) => entry?.icon !== undefined)).toEqual([true, true, true])
    expect(images.map((entry) => entry?.cover !== undefined)).toEqual([true, true, true])
    expect(images.map((entry) => entry?.screenshots?.length ?? 0)).toEqual([1, 0, 0])
    expect(extracted.images).toHaveLength(7)
  })
})
