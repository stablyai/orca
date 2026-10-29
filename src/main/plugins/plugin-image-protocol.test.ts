import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import {
  parsePluginImageUrl,
  pluginInstalledImageUrl,
  pluginShaImageUrl
} from '../../shared/plugins/images/plugin-image-url'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../shared/plugins/manifest/plugin-schema-field-docs'
import { extractCatalogImages } from './catalog/plugin-catalog-image-extraction'
import { PluginImageCache } from './plugin-image-cache'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
const { createPluginImageRequestHandler } = await import('./plugin-image-protocol')

const roots: string[] = []
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
function png(width: number, height: number): Buffer {
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
    ...Buffer.from('IHDR'),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0
  ])
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-image-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin image URLs', () => {
  it('round-trip and refuse anything else', () => {
    const hash = 'a'.repeat(64)
    expect(parsePluginImageUrl(pluginShaImageUrl(hash))).toEqual({ kind: 'sha', sha256: hash })
    expect(parsePluginImageUrl(pluginInstalledImageUrl('acme.demo', hash, 'screenshot-2'))).toEqual(
      {
        kind: 'installed',
        pluginKey: 'acme.demo',
        contentHash: hash,
        slot: 'screenshot-2'
      }
    )
    expect(parsePluginImageUrl(pluginInstalledImageUrl('acme.demo', hash, 'new-file-3'))).toEqual({
      kind: 'installed',
      pluginKey: 'acme.demo',
      contentHash: hash,
      slot: 'new-file-3'
    })
    for (const url of [
      `orca-plugin-image://installed/acme.demo/${hash}/editor-x`,
      'orca-plugin-image://sha/../etc',
      'orca-plugin-image://installed/acme.demo/abc/icon',
      'orca-plugin-image://installed/acme.demo/dev/main',
      'https://example.com/a.png'
    ]) {
      expect(parsePluginImageUrl(url), url).toBeNull()
    }
  })
})

describe('plugin image protocol', () => {
  it('serves cached bytes by hash with nosniff, and installed images by slot', async () => {
    const cache = new PluginImageCache(await temp())
    const cover = png(1600, 1000)
    const hash = await cache.put(cover)
    const pluginRoot = await temp()
    await mkdir(join(pluginRoot, 'images'), { recursive: true })
    await writeFile(join(pluginRoot, 'images', 'icon.png'), png(256, 256))
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'data',
      id: 'demo',
      publisher: 'acme',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      icon: 'images/icon.png'
    })
    const handler = createPluginImageRequestHandler({
      cache,
      findValidPlugin: () => ({
        pluginKey: 'acme.demo',
        rootDir: pluginRoot,
        manifest,
        consentFingerprint: 'x',
        contentHash: 'b'.repeat(64),
        isDev: false
      })
    })
    const fromCache = await handler(new Request(pluginShaImageUrl(hash ?? '')))
    expect(fromCache.status).toBe(200)
    expect(fromCache.headers.get('content-type')).toBe('image/png')
    expect(fromCache.headers.get('x-content-type-options')).toBe('nosniff')
    const icon = await handler(
      new Request(pluginInstalledImageUrl('acme.demo', 'b'.repeat(64), 'icon'))
    )
    expect(icon.status).toBe(200)
    const stale = await handler(
      new Request(pluginInstalledImageUrl('acme.demo', 'c'.repeat(64), 'icon'))
    )
    expect(stale.status).toBe(404)
    const missing = await handler(new Request(pluginShaImageUrl('d'.repeat(64))))
    expect(missing.status).toBe(404)
  })

  it('serves custom editor and new-file icons by slot, under the plugin icon rules', async () => {
    const pluginRoot = await temp()
    await mkdir(join(pluginRoot, 'images'), { recursive: true })
    await writeFile(join(pluginRoot, 'images', 'tab.png'), png(128, 128))
    await writeFile(join(pluginRoot, 'images', 'wide.png'), png(256, 128))
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'draw',
      publisher: 'acme',
      name: 'Draw',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes: {
        customEditors: [
          {
            id: 'draw',
            title: 'Draw',
            extensions: ['.draw'],
            entry: 'e.html',
            icon: 'images/tab.png'
          }
        ],
        newFiles: [
          { id: 'drawing', title: 'New drawing', extension: '.draw', icon: 'images/wide.png' }
        ]
      }
    })
    const handler = createPluginImageRequestHandler({
      cache: new PluginImageCache(await temp()),
      findValidPlugin: () => ({
        pluginKey: 'acme.draw',
        rootDir: pluginRoot,
        manifest,
        consentFingerprint: 'x',
        contentHash: 'b'.repeat(64),
        isDev: false
      })
    })
    const url = (slot: string) => pluginInstalledImageUrl('acme.draw', 'b'.repeat(64), slot)
    expect((await handler(new Request(url('editor-0')))).status).toBe(200)
    // Not square, so refused like a plugin icon would be.
    expect((await handler(new Request(url('new-file-0')))).status).toBe(404)
    expect((await handler(new Request(url('editor-1')))).status).toBe(404)
  })

  it('refuses to cache anything that is not a static raster image', async () => {
    const cache = new PluginImageCache(await temp())
    await expect(
      cache.put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ).resolves.toBeNull()
  })
})

describe('extractCatalogImages', () => {
  it('keeps images whose bytes match and drops the rest', async () => {
    const cover = png(1600, 1000)
    const files: Record<string, Buffer> = { 'a/cover.png': cover, 'a/wrong.png': png(1600, 1000) }
    const image = (path: string, hash: string) => ({
      path,
      alt: 'x',
      sha256: hash,
      width: 1600,
      height: 1000
    })
    const release = {
      version: '1.0.0',
      commit: 'c'.repeat(40),
      contentHash: 'f'.repeat(64),
      execution: 'data' as const,
      minimumOrca: '1.4.0',
      types: ['app-theme' as const],
      images: {
        cover: image('a/cover.png', sha(cover)),
        screenshots: [image('a/wrong.png', 'e'.repeat(64)), image('a/missing.png', 'd'.repeat(64))]
      }
    }
    const result = await extractCatalogImages(
      {
        name: 'Acme',
        owner: 'acme',
        plugins: [
          {
            id: 'acme.demo',
            source: { kind: 'git', url: 'https://github.com/acme/demo.git', ref: 'main' },
            categories: [],
            releases: [release]
          }
        ]
      },
      async (path) => files[path] ?? null
    )
    expect(result.images).toEqual([cover])
    expect(result.marketplace.plugins[0]?.releases?.[0]?.images).toEqual({
      cover: release.images.cover
    })
  })
})
