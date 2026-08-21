import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { hashPluginTree } from './plugin-content-hash'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginVmRecipeRegistry } from './plugin-vm-recipe-registry'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function recipePlugin(
  id: string,
  artifacts: { path: string; recipe: unknown }[]
): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-vm-recipe-'))
  roots.push(rootDir)
  await mkdir(join(rootDir, 'recipes'))
  await Promise.all(
    artifacts.map((artifact) =>
      writeFile(join(rootDir, artifact.path), JSON.stringify(artifact.recipe), 'utf8')
    )
  )
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher: 'orca-samples',
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { vmRecipes: artifacts.map((artifact) => ({ path: artifact.path })) },
    capabilities: []
  })
  const content = await hashPluginTree(rootDir)
  if (!content.ok) {
    throw new Error(content.error)
  }
  return {
    pluginKey: `orca-samples.${id}`,
    rootDir,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest, content.hash),
    consentContentHash: content.hash,
    contentHash: null,
    isDev: true
  }
}

function artifact(id: string): {
  schemaVersion: 1
  id: string
  name: string
  create: string
  suspend: string
  resume: string
  destroy: string
} {
  return {
    schemaVersion: 1,
    id,
    name: `Recipe ${id}`,
    create: `create-${id}`,
    suspend: `suspend-${id}`,
    resume: `resume-${id}`,
    destroy: `destroy-${id}`
  }
}

describe('PluginVmRecipeRegistry', () => {
  it('retains pending previews and exposes only approved recipes', async () => {
    const plugin = await recipePlugin('recipes', [
      { path: 'recipes/cloud.json', recipe: artifact('cloud') }
    ])
    const registry = new PluginVmRecipeRegistry()

    await registry.reconcile([plugin], () => false)

    expect(registry.list()).toEqual([])
    expect(registry.preview(plugin.pluginKey)).toMatchObject([
      { pluginKey: plugin.pluginKey, recipe: { id: 'cloud', create: 'create-cloud' } }
    ])

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toMatchObject([{ recipe: { id: 'cloud' } }])
  })

  it('rejects malformed artifacts and duplicate ids within one plugin', async () => {
    const malformed = await recipePlugin('malformed', [
      {
        path: 'recipes/bad.json',
        recipe: { schemaVersion: 1, id: 'bad', name: 'Bad', create: 'create', suspend: 'stop' }
      }
    ])
    const duplicate = await recipePlugin('duplicate', [
      { path: 'recipes/one.json', recipe: artifact('same') },
      { path: 'recipes/two.json', recipe: artifact('same') }
    ])
    const registry = new PluginVmRecipeRegistry()

    await registry.reconcile([malformed, duplicate], () => true)

    expect(registry.list()).toEqual([])
    expect(registry.error(malformed.pluginKey)).toContain('suspend and resume')
    expect(registry.error(duplicate.pluginKey)).toContain('duplicate VM recipe id')
  })

  it('errors every approved plugin that contributes the same global id', async () => {
    const first = await recipePlugin('first', [
      { path: 'recipes/shared.json', recipe: artifact('shared') }
    ])
    const second = await recipePlugin('second', [
      { path: 'recipes/shared.json', recipe: artifact('shared') }
    ])
    const registry = new PluginVmRecipeRegistry()

    await registry.reconcile([first, second], () => true)

    expect(registry.list()).toEqual([])
    expect(registry.error(first.pluginKey)).toContain('multiple plugins')
    expect(registry.error(second.pluginKey)).toContain('multiple plugins')
  })

  it('deactivates disabled recipes and removes previews after uninstall', async () => {
    const plugin = await recipePlugin('lifecycle', [
      { path: 'recipes/cloud.json', recipe: artifact('cloud') }
    ])
    const registry = new PluginVmRecipeRegistry()

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toHaveLength(1)

    await registry.reconcile([plugin], () => false)
    expect(registry.list()).toEqual([])
    expect(registry.preview(plugin.pluginKey)).toHaveLength(1)

    await registry.reconcile([], () => false)
    expect(registry.preview(plugin.pluginKey)).toEqual([])
    expect(registry.error(plugin.pluginKey)).toBeNull()
  })

  it('refuses recipe bytes changed after the reviewed content identity', async () => {
    const plugin = await recipePlugin('mutable', [
      { path: 'recipes/cloud.json', recipe: artifact('cloud') }
    ])
    // Exercise the installed-tree identity as well as mutable dev previews.
    plugin.contentHash = plugin.consentContentHash ?? null
    const registry = new PluginVmRecipeRegistry()

    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toHaveLength(1)

    await writeFile(
      join(plugin.rootDir, 'recipes', 'cloud.json'),
      JSON.stringify({ ...artifact('cloud'), create: 'changed-after-review' }),
      'utf8'
    )
    await registry.reconcile([plugin], () => true)

    expect(registry.list()).toEqual([])
    expect(registry.preview(plugin.pluginKey)).toEqual([])
    expect(registry.error(plugin.pluginKey)).toContain('changed since it was reviewed')
  })
})
