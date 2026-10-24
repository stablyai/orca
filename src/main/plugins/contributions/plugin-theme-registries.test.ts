import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PluginContentVerifier } from '../plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import {
  createPluginTerminalThemeRegistry,
  createPluginThemeRegistry
} from './plugin-theme-registries'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function themePlugin(files: { app?: unknown; terminal?: unknown }) {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-theme-registry-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'app.json'), JSON.stringify(files.app ?? {}))
  await writeFile(join(rootDir, 'terminal.json'), JSON.stringify(files.terminal ?? {}))
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'midnight',
    publisher: 'samples',
    name: 'Midnight',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      themes: [{ id: 'midnight', label: 'Midnight', path: 'app.json' }],
      terminalThemes: [{ id: 'midnight', label: 'Midnight', path: 'terminal.json' }]
    }
  })
  const plugin: ValidDiscoveredPlugin = {
    pluginKey: 'samples.midnight',
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
  return plugin
}

const terminal = {
  schemaVersion: 1,
  mode: 'dark',
  terminal: { background: '#000000', foreground: '#ffffff', red: '#ff0000' }
}

describe('plugin theme registries', () => {
  it('loads app and terminal themes under host-owned ids', async () => {
    const plugin = await themePlugin({
      app: { base: 'dark', tokens: { '--background': '#101010', '--foreground': '#f0f0f0' } },
      terminal
    })
    const themes = createPluginThemeRegistry(new PluginContentVerifier())
    const terminalThemes = createPluginTerminalThemeRegistry(new PluginContentVerifier())

    await themes.reconcile([plugin], () => true)
    await terminalThemes.reconcile([plugin], () => true)

    expect(themes.list()).toEqual([
      expect.objectContaining({
        id: 'plugin:samples.midnight/midnight',
        pluginKey: 'samples.midnight',
        pluginName: 'Midnight',
        label: 'Midnight',
        base: 'dark',
        tokens: expect.objectContaining({ '--background': '#101010', '--card': '#101010' })
      })
    ])
    expect(terminalThemes.list()).toEqual([
      expect.objectContaining({ id: 'plugin:samples.midnight/midnight', mode: 'dark' })
    ])
  })

  it('reports an invalid theme and drops it, then clears when the plugin is disabled', async () => {
    const plugin = await themePlugin({
      app: { base: 'dark', tokens: { '--background': 'url(https://example.com)' } },
      terminal: { ...terminal, terminal: { background: '#000000' } }
    })
    const themes = createPluginThemeRegistry(new PluginContentVerifier())
    const terminalThemes = createPluginTerminalThemeRegistry(new PluginContentVerifier())

    await themes.reconcile([plugin], () => true)
    await terminalThemes.reconcile([plugin], () => true)
    expect(themes.list()).toEqual([])
    expect(themes.error(plugin.pluginKey)).toContain('theme "midnight" is invalid')
    expect(terminalThemes.error(plugin.pluginKey)).toContain('requires background, foreground')

    await themes.reconcile([plugin], () => false)
    expect(themes.error(plugin.pluginKey)).toBeNull()
  })
})
