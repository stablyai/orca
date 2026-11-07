import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_FONTS_SINCE } from '../../shared/plugins/contributions/plugin-font-contribution'
import { pluginInstalledImageUrl } from '../../shared/plugins/images/plugin-image-url'
import { validatePluginInstallContent } from './plugin-artifact-validation'
import { createPluginImageRequestHandler } from './plugin-image-protocol'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginImageCache } from './plugin-image-cache'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

const roots: string[] = []
const WOFF2 = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0, 0, 0, 0])
const TTF = Buffer.from([0, 1, 0, 0, 0, 0x0a, 0x00, 0x80])
const WOFF2_COLLECTION = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x74, 0x74, 0x63, 0x66, 0, 0, 0, 0])

async function fontPlugin(file: Buffer, path = 'fonts/mono.woff2') {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-fonts-'))
  roots.push(root)
  await mkdir(join(root, 'fonts'), { recursive: true })
  await writeFile(join(root, path), file)
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'data',
    id: 'mono',
    name: 'Mono',
    version: '1.0.0',
    engines: { orca: `>=${PLUGIN_FONTS_SINCE}` },
    contributes: { fonts: [{ family: 'Mono', faces: [{ path }] }] }
  })
  return { root, manifest }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin font files', () => {
  it('accepts a WOFF2 file', async () => {
    const good = await fontPlugin(WOFF2)
    await expect(validatePluginInstallContent(good.root, good.manifest)).resolves.toEqual({
      ok: true
    })
  })

  it.each([
    ['a TrueType file renamed to .woff2', TTF],
    ['a WOFF2-wrapped font collection', WOFF2_COLLECTION]
  ])('refuses %s', async (_label, bytes) => {
    const bad = await fontPlugin(bytes)
    await expect(validatePluginInstallContent(bad.root, bad.manifest)).resolves.toEqual({
      ok: false,
      error: 'font "Mono" fonts/mono.woff2: is not a WOFF or WOFF2 font matching its extension'
    })
  })

  it('serves a font only for an enabled plugin, typed and unsniffable', async () => {
    const { root, manifest } = await fontPlugin(WOFF2)
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'acme.mono',
      rootDir: root,
      manifest,
      consentFingerprint: 'fingerprint',
      isDev: false,
      contentHash: 'a'.repeat(64)
    }
    let enabled = true
    const handler = createPluginImageRequestHandler({
      cache: new PluginImageCache(root),
      findValidPlugin: () => plugin,
      findApprovedPlugin: () => (enabled ? plugin : null)
    })
    const url = pluginInstalledImageUrl('acme.mono', 'a'.repeat(64), 'font-0-0')
    const served = await handler(new Request(url))
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('font/woff2')
    expect(served.headers.get('x-content-type-options')).toBe('nosniff')
    expect(served.headers.get('access-control-allow-origin')).toBe('*')
    expect(Buffer.from(await served.arrayBuffer())).toEqual(WOFF2)
    enabled = false
    expect((await handler(new Request(url))).status).toBe(404)
  })
})
