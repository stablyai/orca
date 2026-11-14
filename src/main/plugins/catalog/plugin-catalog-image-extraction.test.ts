import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import type {
  PluginMarketplace,
  PluginMarketplaceEntry
} from '../../../shared/plugins/catalog/plugin-marketplace'
import type { PluginCatalogRelease } from '../../../shared/plugins/catalog/plugin-catalog-release'
import { extractCatalogImages } from './plugin-catalog-image-extraction'

const MiB = 1024 * 1024
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/** A PNG header padded to `size` bytes with an IDAT chunk; `seed` makes the bytes distinct. */
function png(width: number, height: number, size: number, seed: number): Buffer {
  const ihdr = [...Buffer.from('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ihdr])
  const dataLength = size - head.length - 16
  const data = Buffer.alloc(dataLength)
  data.writeUInt32BE(seed)
  const idat = Buffer.from([...be32(dataLength), ...Buffer.from('IDAT')])
  return Buffer.concat([head, Buffer.alloc(4), idat, data, Buffer.alloc(4)])
}

const files = new Map<string, Buffer>()
let seed = 0
function image(path: string, width: number, height: number, size: number) {
  const bytes = png(width, height, size, seed++)
  files.set(path, bytes)
  return {
    path,
    alt: path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width,
    height
  }
}
const read = async (path: string, maxBytes: number): Promise<Buffer | null> => {
  const bytes = files.get(path)
  return bytes && bytes.byteLength <= maxBytes ? bytes : null
}

function release(version: string, images?: PluginCatalogRelease['images']): PluginCatalogRelease {
  return {
    version,
    commit: 'c'.repeat(40),
    contentHash: 'f'.repeat(64),
    execution: 'data',
    minimumOrca: '1.4.0',
    ...(images ? { images } : {})
  }
}
function plugin(id: string, releases: PluginCatalogRelease[]): PluginMarketplaceEntry {
  return {
    id,
    source: { kind: 'git', url: `https://github.com/example/${id}.git`, ref: 'main' },
    categories: ['themes'],
    releases
  }
}
const catalog = (plugins: PluginMarketplaceEntry[]): PluginMarketplace => ({
  name: 'Community',
  owner: 'example',
  plugins
})
const shots = (id: string, count: number) =>
  Array.from({ length: count }, (_, n) => image(`${id}/shot-${n}.png`, 1280, 800, 1.5 * MiB))
const imagesOf = (result: { marketplace: PluginMarketplace }, id: string, index = 0) =>
  result.marketplace.plugins.find((entry) => entry.id === id)?.releases?.[index]?.images

describe('extractCatalogImages', () => {
  beforeEach(() => {
    files.clear()
    seed = 0
  })

  it('keeps a late plugin cover and icon after earlier screenshots would fill the budget', async () => {
    // 8 × 6 × 1.5 MiB = 72 MiB of screenshots ahead of the last plugin in catalog order.
    const early = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letter) =>
      plugin(`${letter}.shots`, [release('1.0.0', { screenshots: shots(letter, 6) })])
    )
    const icon = image('z/icon.png', 256, 256, 200 * 1024)
    const cover = image('z/cover.png', 1600, 1000, 900 * 1024)
    const late = plugin('z.cards', [release('1.0.0', { icon, cover })])

    const result = await extractCatalogImages(catalog([...early, late]), read)

    expect(imagesOf(result, 'z.cards')).toEqual({ icon, cover })
  })

  it('keeps newest card art before any older release consumes the budget', async () => {
    const early = Array.from({ length: 64 }, (_, n) =>
      plugin(`a.history-${n}`, [
        release('2.0.0'),
        release('1.0.0', { cover: image(`a/old-${n}.png`, 1600, 1000, MiB) })
      ])
    )
    const cover = image('z/new.png', 1600, 1000, MiB)
    const result = await extractCatalogImages(
      catalog([...early, plugin('z.newest', [release('1.0.0', { cover })])]),
      read
    )

    expect(imagesOf(result, 'z.newest')).toEqual({ cover })
    expect(imagesOf(result, 'a.history-0', 1)?.cover?.path).toBe('a/old-0.png')
    expect(imagesOf(result, 'a.history-63', 1)).toBeUndefined()
  })

  it('keeps a valid screenshot whose bytes fail as an icon', async () => {
    const wide = image('a/wide.png', 1280, 800, 200 * 1024)
    const entry = plugin('a.shared', [release('1.0.0', { icon: wide, screenshots: [wide] })])

    const result = await extractCatalogImages(catalog([entry]), read)

    expect(imagesOf(result, 'a.shared')).toEqual({ screenshots: [wide] })
  })

  it('keeps a cover whose bytes are missing at another plugin path', async () => {
    const cover = image('b/cover.png', 1600, 1000, 200 * 1024)
    const missing = { ...cover, path: 'a/missing.png' }
    const first = plugin('a.missing', [release('1.0.0', { cover: missing })])
    const second = plugin('b.cover', [release('1.0.0', { cover })])

    const result = await extractCatalogImages(catalog([first, second]), read)

    expect(imagesOf(result, 'a.missing')).toBeUndefined()
    expect(imagesOf(result, 'b.cover')).toEqual({ cover })
  })

  it('checks bytes kept as one plugin cover against the icon rules of another', async () => {
    const cover = image('a/cover.png', 1600, 1000, 200 * 1024)
    const first = plugin('a.cover', [release('1.0.0', { cover })])
    const second = plugin('b.icon', [release('1.0.0', { icon: cover })])

    const result = await extractCatalogImages(catalog([first, second]), read)

    expect(imagesOf(result, 'a.cover')).toEqual({ cover })
    expect(imagesOf(result, 'b.icon')).toBeUndefined()
  })
})
