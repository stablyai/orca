import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginIconThemeRegistry } from './plugin-icon-theme-registry'

const roots: string[] = []

async function iconPlugin(
  svg = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#38bdf8"/></svg>'
): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-icon-theme-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'icons'))
  await writeFile(join(rootDir, 'icons', 'folder.svg'), svg)
  await writeFile(
    join(rootDir, 'icons', 'theme.json'),
    JSON.stringify({ schemaVersion: 1, icons: { folder: 'icons/folder.svg' } })
  )
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'icons',
    publisher: 'sample',
    name: 'Icons',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      iconThemes: [{ id: 'colorful', label: 'Colorful', path: 'icons/theme.json' }]
    },
    capabilities: []
  })
  return {
    pluginKey: 'sample.icons',
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginIconThemeRegistry', () => {
  it('loads approved SVG themes as data URLs', async () => {
    const plugin = await iconPlugin()
    const registry = new PluginIconThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({
      id: 'plugin:sample.icons/colorful',
      pluginKey: 'sample.icons',
      themeId: 'colorful',
      label: 'Colorful',
      assets: {
        'icons/folder.svg': {
          src: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
          monochrome: false
        }
      }
    })
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })

  it('rejects non-SVG assets and clears errors when disabled', async () => {
    const plugin = await iconPlugin('<html></html>')
    const registry = new PluginIconThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.error(plugin.pluginKey)).toContain('must contain an SVG document')

    await registry.reconcile([plugin], () => false)
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })

  it.each([
    ['an XML comment', '<!-- Generator: Illustrator -->'],
    ['a simple doctype', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN">']
  ])('accepts SVG assets prefixed by %s', async (_label, prefix) => {
    const plugin = await iconPlugin(
      `${prefix}\n<svg xmlns="http://www.w3.org/2000/svg"><path fill="#38bdf8"/></svg>`
    )
    const registry = new PluginIconThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toHaveLength(1)
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })
})
