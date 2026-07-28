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

async function pluginWithIcons(svg: string): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-icon-theme-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'icons'))
  await writeFile(
    join(rootDir, 'icons', 'theme.json'),
    JSON.stringify({
      schemaVersion: 1,
      icons: { file: 'icons/file.svg' },
      fileExtensions: { ts: 'icons/typescript.svg' }
    })
  )
  await Promise.all([
    writeFile(join(rootDir, 'icons', 'file.svg'), svg),
    writeFile(join(rootDir, 'icons', 'typescript.svg'), '<svg><path d="M0 0h16v16z"/></svg>')
  ])
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'icons',
    publisher: 'orca-samples',
    name: 'Icons',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { iconThemes: [{ id: 'minimal', label: 'Minimal', path: 'icons/theme.json' }] },
    capabilities: []
  })
  return {
    pluginKey: 'orca-samples.icons',
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
  it('loads intrinsic-color SVGs as images and currentColor SVGs as masks', async () => {
    const plugin = await pluginWithIcons('<svg><path fill="currentColor" d="M0 0h16v16z"/></svg>')
    const registry = new PluginIconThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'plugin:orca-samples.icons/minimal',
        label: 'Minimal'
      })
    ])
    await expect(registry.load('plugin:orca-samples.icons/minimal')).resolves.toEqual(
      expect.objectContaining({
        id: 'plugin:orca-samples.icons/minimal',
        icons: {
          file: {
            dataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
            rendering: 'mask'
          }
        },
        fileExtensions: {
          ts: {
            dataUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
            rendering: 'image'
          }
        }
      })
    )
  })

  it('fails closed when a selected SVG is active and clears metadata when disabled', async () => {
    const plugin = await pluginWithIcons('<svg><foreignObject>bad</foreignObject></svg>')
    const registry = new PluginIconThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toHaveLength(1)
    await expect(registry.load('plugin:orca-samples.icons/minimal')).rejects.toThrow('not allowed')

    await registry.reconcile([plugin], () => false)
    expect(registry.list()).toEqual([])
    await expect(registry.load('plugin:orca-samples.icons/minimal')).resolves.toBeNull()
  })
})
