import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import { hashPluginTree } from './plugin-content-hash'
import { PluginContentPackRegistry } from './plugin-content-pack-registry'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginContentPackRegistry', () => {
  it('activates all contributions from a plugin atomically', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-content-pack-registry-'))
    roots.push(rootDir)
    await Promise.all([mkdir(join(rootDir, 'icons')), mkdir(join(rootDir, 'terminal'))])
    await Promise.all([
      writeFile(
        join(rootDir, 'icons', 'invalid.json'),
        JSON.stringify({ schemaVersion: 1, icons: { file: 42 } })
      ),
      writeFile(
        join(rootDir, 'terminal', 'valid.json'),
        JSON.stringify({
          schemaVersion: 1,
          mode: 'dark',
          terminal: {
            background: '#101010',
            foreground: '#f0f0f0',
            black: '#000000'
          }
        })
      )
    ])
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'mixed-content',
      publisher: 'orca-samples',
      name: 'Mixed Content',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        iconThemes: [{ id: 'broken', label: 'Broken', path: 'icons/invalid.json' }],
        terminalThemes: [{ id: 'valid', label: 'Valid', path: 'terminal/valid.json' }]
      },
      capabilities: []
    })
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.mixed-content',
      rootDir,
      manifest,
      consentFingerprint: fingerprintPluginConsent(manifest),
      contentHash: null,
      isDev: true
    }
    const registry = new PluginContentPackRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)

    expect(registry.error(plugin.pluginKey)).toContain('number')
    expect(registry.iconThemes.list()).toEqual([])
    expect(registry.terminalThemes.list()).toEqual([])
  })

  it('rolls back valid packs when a VM recipe from the same plugin is invalid', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-content-pack-vm-'))
    roots.push(rootDir)
    await Promise.all([mkdir(join(rootDir, 'terminal')), mkdir(join(rootDir, 'recipes'))])
    await Promise.all([
      writeFile(
        join(rootDir, 'terminal', 'valid.json'),
        JSON.stringify({
          schemaVersion: 1,
          mode: 'dark',
          terminal: { background: '#101010', foreground: '#f0f0f0', black: '#000000' }
        })
      ),
      writeFile(
        join(rootDir, 'recipes', 'invalid.json'),
        JSON.stringify({ schemaVersion: 1, id: 'bad', name: 'Bad', create: 'create', resume: 'up' })
      )
    ])
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'mixed-recipes',
      publisher: 'orca-samples',
      name: 'Mixed Recipes',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        terminalThemes: [{ id: 'valid', label: 'Valid', path: 'terminal/valid.json' }],
        vmRecipes: [{ path: 'recipes/invalid.json' }]
      },
      capabilities: []
    })
    const content = await hashPluginTree(rootDir)
    if (!content.ok) {
      throw new Error(content.error)
    }
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.mixed-recipes',
      rootDir,
      manifest,
      consentFingerprint: fingerprintPluginConsent(manifest, content.hash),
      consentContentHash: content.hash,
      contentHash: null,
      isDev: true
    }
    const registry = new PluginContentPackRegistry(new PluginContentVerifier())

    await registry.reconcile([plugin], () => true)

    expect(registry.error(plugin.pluginKey)).toContain('suspend and resume')
    expect(registry.terminalThemes.list()).toEqual([])
    expect(registry.vmRecipes.list()).toEqual([])
  })
})
