import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginInstalledImageUrl } from '../../../shared/plugins/images/plugin-image-url'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { PluginImageCache } from './plugin-image-cache'
import { createPluginImageRequestHandler } from './plugin-image-protocol'

vi.mock('electron', () => ({ protocol: {} }))

const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function png(width: number, height: number): Buffer {
  const ihdr = [0, 0, 0, 13, ...Buffer.from('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0]
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, 0, 0, 0, 0])
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat()
  return [...be32(body.length + 8), ...Buffer.from(type), ...body]
}

/** A header-only MP4: one video track of `codec`, 960×540, 30 seconds. */
function mp4(codec: string): Buffer {
  const entry = [...Buffer.from(codec), ...Array(24).fill(0), 3, 192, 2, 28]
  const stsd = box('stsd', [0, 0, 0, 0], be32(1), be32(entry.length + 4), entry)
  const trak = box(
    'trak',
    box(
      'mdia',
      box('hdlr', Array(8).fill(0), [...Buffer.from('vide')]),
      box('minf', box('stbl', stsd))
    )
  )
  const mvhd = box('mvhd', Array(12).fill(0), be32(1000), be32(30_000), Array(80).fill(0))
  return Buffer.from([...box('ftyp', [...Buffer.from('isom')]), ...box('moov', mvhd, trak)])
}

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function servePluginTheme(background: unknown) {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-image-protocol-'))
  roots.push(rootDir)
  const theme = {
    base: 'dark',
    tokens: { '--background': '#101010', '--foreground': '#f0f0f0' }
  }
  await writeFile(join(rootDir, 'app.json'), JSON.stringify({ ...theme, background }))
  await writeFile(join(rootDir, 'still.png'), png(960, 540))
  await writeFile(join(rootDir, 'loop.mp4'), mp4('avc1'))
  await writeFile(join(rootDir, 'hevc.mp4'), mp4('hvc1'))
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'dusk',
    publisher: 'samples',
    name: 'Dusk',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { themes: [{ id: 'dusk', title: 'Dusk', path: 'app.json' }] }
  })
  const plugin: ValidDiscoveredPlugin = {
    pluginKey: 'samples.dusk',
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
  const handle = createPluginImageRequestHandler({
    cache: new PluginImageCache(join(rootDir, 'cache')),
    findValidPlugin: (key) => (key === plugin.pluginKey ? plugin : null),
    findApprovedPlugin: () => null
  })
  return async (slot: string) => {
    const response = await handle(
      new Request(pluginInstalledImageUrl(plugin.pluginKey, 'dev', slot))
    )
    return response.status === 200 ? response.headers.get('Content-Type') : response.status
  }
}

describe('plugin image protocol: theme backgrounds', () => {
  it('serves the static image and the video from their own slots', async () => {
    const serve = await servePluginTheme({ path: 'still.png', videoPath: 'loop.mp4' })
    expect(await serve('theme-0')).toBe('image/png')
    expect(await serve('theme-0-video')).toBe('video/mp4')
  })

  it('keeps each slot to its own kind and refuses codecs that do not play everywhere', async () => {
    expect(await (await servePluginTheme({ path: 'loop.mp4' }))('theme-0')).toBe(404)
    expect(await (await servePluginTheme({ path: 'still.png' }))('theme-0-video')).toBe(404)
    const hevc = await servePluginTheme({ path: 'still.png', videoPath: 'hevc.mp4' })
    expect(await hevc('theme-0-video')).toBe(404)
  })
})
