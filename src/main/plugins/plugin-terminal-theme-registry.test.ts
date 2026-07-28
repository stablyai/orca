import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginTerminalThemeRegistry } from './plugin-terminal-theme-registry'

const roots: string[] = []

async function pluginWithTerminalTheme(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-terminal-theme-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'terminal'))
  await writeFile(
    join(rootDir, 'terminal', 'nord.json'),
    JSON.stringify({
      schemaVersion: 1,
      mode: 'dark',
      terminal: {
        background: '#101010',
        foreground: '#f0f0f0',
        black: '#000000',
        red: '#ff0000'
      }
    })
  )
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'terminal',
    publisher: 'orca-samples',
    name: 'Terminal',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      terminalThemes: [{ id: 'nord', label: 'Nord Terminal', path: 'terminal/nord.json' }]
    },
    capabilities: []
  })
  return {
    pluginKey: 'orca-samples.terminal',
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

describe('PluginTerminalThemeRegistry', () => {
  it('loads and removes approved terminal palettes', async () => {
    const plugin = await pluginWithTerminalTheme()
    const registry = new PluginTerminalThemeRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'plugin:orca-samples.terminal/nord',
        label: 'Nord Terminal',
        mode: 'dark',
        terminal: expect.objectContaining({ background: '#101010', red: '#ff0000' })
      })
    ])

    await registry.reconcile([plugin], () => false)
    expect(registry.list()).toEqual([])
  })
})
