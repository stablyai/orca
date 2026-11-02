import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  isOfficialOrganizationGitSource,
  hasOfficialPluginPublisher,
  pluginMarketplaceSchema
} from '../../shared/plugins/catalog/plugin-marketplace'
import { bootstrapBundledPlugins, resolveBundledPluginRoot } from './plugin-bundled-bootstrap'
import { inspectPluginInstallTree } from './installation/plugin-install-staging'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../../shared/plugins/installation/plugin-host-version'

const launchRoot = join(process.cwd(), 'resources', 'plugins', 'launch')
const temporaryRoots: string[] = []

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readBundledPluginKeys(): Promise<string[]> {
  const index = z
    .object({ plugins: z.array(z.object({ pluginKey: z.string() })) })
    .parse(await readJson(join(launchRoot, 'bundled-plugins.json')))
  return index.plugins.map((plugin) => plugin.pluginKey)
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('Phase 1 launch plugin content', () => {
  it('lists and validates the launch plugin packs', async () => {
    const marketplace = pluginMarketplaceSchema.parse(
      await readJson(join(launchRoot, 'orca-marketplace.json'))
    )
    expect(marketplace.plugins.map((plugin) => plugin.id).sort()).toEqual([
      'stablyai.orca-multipass-recipes'
    ])
    expect(
      marketplace.plugins.filter(
        (plugin) =>
          hasOfficialPluginPublisher(plugin.id) &&
          isOfficialOrganizationGitSource(plugin.source.url)
      ).length
    ).toBe(marketplace.plugins.length)

    const localPluginDirectories = (await readdir(launchRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const shippedKeys = [
      ...marketplace.plugins.map((plugin) => plugin.id),
      ...(await readBundledPluginKeys())
    ].sort()
    expect(shippedKeys).toEqual(localPluginDirectories)

    const contributionKinds = new Set<string>()
    for (const pluginKey of shippedKeys) {
      const inspection = await inspectPluginInstallTree({
        rootDir: join(launchRoot, pluginKey),
        hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE,
        identity: { pluginKey }
      })
      expect(inspection, `${pluginKey} must pass the production install inspection`).toMatchObject({
        ok: true
      })
      if (!inspection.ok) {
        continue
      }
      const contributes = inspection.manifest.contributes
      if (contributes.vmRecipes.length > 0) {
        contributionKinds.add('vm-recipe')
      }
      if (contributes.themes.length > 0) {
        contributionKinds.add('theme')
      }
    }
    expect(contributionKinds).toEqual(new Set(['vm-recipe', 'theme']))
  })

  it('publishes every bundled pack only when its release hash matches exact bytes', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-launch-content-'))
    temporaryRoots.push(userDataPath)

    const result = await bootstrapBundledPlugins({
      root: launchRoot,
      userDataPath,
      hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE
    })

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual(await readBundledPluginKeys())
    expect(result.installed.every(hasOfficialPluginPublisher)).toBe(true)
  })

  it('boots release-indexed content from the packaged resources layout', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'orca-packaged-resources-'))
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-packaged-user-data-'))
    temporaryRoots.push(resourcesPath, userDataPath)
    const packagedRoot = join(resourcesPath, 'plugins', 'launch')
    await cp(launchRoot, packagedRoot, { recursive: true })

    const result = await bootstrapBundledPlugins({
      root: resolveBundledPluginRoot({
        isPackaged: true,
        resourcesPath,
        appPath: join(resourcesPath, 'app.asar')
      }),
      userDataPath,
      hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE
    })

    expect(result.errors).toEqual([])
    expect(result.installed).toEqual(await readBundledPluginKeys())
  })
})
