import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginThemeRegistry } from './plugin-theme-registry'

const roots: string[] = []

async function pluginWithTheme(theme: unknown): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-theme-registry-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'themes'))
  await writeFile(join(rootDir, 'themes', 'nord.json'), JSON.stringify(theme))
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'themes',
    publisher: 'orca-samples',
    name: 'Theme pack',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      themes: [{ id: 'nord', label: 'Nord', path: 'themes/nord.json' }]
    },
    capabilities: []
  })
  return {
    pluginKey: 'orca-samples.themes',
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

describe('PluginThemeRegistry', () => {
  it('loads approved themes under a host-owned qualified id', async () => {
    const plugin = await pluginWithTheme({
      base: 'dark',
      tokens: { '--background': '#111', '--foreground': '#eee' }
    })
    const registry = new PluginThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toEqual([
      {
        id: 'plugin:orca-samples.themes/nord',
        pluginKey: 'orca-samples.themes',
        contributionId: 'nord',
        label: 'Nord',
        base: 'dark',
        tokens: { '--background': '#111', '--foreground': '#eee' }
      }
    ])
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })

  it('removes disabled themes and records malformed artifacts as plugin errors', async () => {
    const plugin = await pluginWithTheme({
      base: 'dark',
      tokens: { '--destructive': '#000' }
    })
    const registry = new PluginThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.error(plugin.pluginKey)).toContain('public plugin theme token set')

    await registry.reconcile([plugin], () => false)
    expect(registry.list()).toEqual([])
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })
})
