import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePluginFileIconUrl } from '../../shared/plugins/plugin-file-icon-resolution'
import { PluginContentPackRegistry } from './plugin-content-pack-registry'
import { PluginContentVerifier } from './plugin-content-integrity'
import { discoverPlugins, isInvalidDiscoveredPlugin } from './plugin-discovery'

const EXAMPLE_DIR = fileURLToPath(
  new URL('../../../examples/plugins/demo-file-icons', import.meta.url)
)

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * Drives the real dev-plugin path a user hits via `devPluginPaths`: discovery,
 * manifest validation, then content-pack publication.
 */
describe('icon theme discovery integration', () => {
  it('discovers, validates, and publishes the example theme from a dev path', async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), 'orca-plugins-empty-'))
    dirs.push(pluginsDir)

    const discovered = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [EXAMPLE_DIR],
      hostVersion: '1.4.162'
    })

    expect(discovered).toHaveLength(1)
    const plugin = discovered[0]
    expect(plugin).toBeDefined()
    if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
      throw new Error(
        `example plugin failed discovery: ${plugin && 'error' in plugin ? plugin.error : 'missing'}`
      )
    }
    expect(plugin.pluginKey).toBe('orca-samples.demo-file-icons')
    expect(plugin.manifest.contributes.iconThemes).toEqual([
      { id: 'demo', label: 'Demo Icons', path: 'icon-theme.json' }
    ])
    // A pure content pack needs no capabilities and no worker entry.
    expect(plugin.manifest.capabilities).toEqual([])
    expect(plugin.manifest.main).toBeUndefined()

    const contentPacks = new PluginContentPackRegistry(new PluginContentVerifier(), () => false)
    await contentPacks.reconcile(discovered, () => true)

    expect(contentPacks.error(plugin.pluginKey)).toBeNull()
    const theme = contentPacks.iconThemes.list()[0]
    expect(theme?.id).toBe('orca-samples.demo-file-icons#demo')
    expect(resolvePluginFileIconUrl(theme, 'src/index.ts')).toBe(theme?.icons.typescript)
    expect(resolvePluginFileIconUrl(theme, 'package.json')).toBe(theme?.icons.npm)
  })

  it('withholds the theme while the plugin is on the kill list', async () => {
    const pluginsDir = await mkdtemp(join(tmpdir(), 'orca-plugins-empty-'))
    dirs.push(pluginsDir)
    const discovered = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [EXAMPLE_DIR],
      hostVersion: '1.4.162'
    })

    const contentPacks = new PluginContentPackRegistry(new PluginContentVerifier(), () => true)
    await contentPacks.reconcile(discovered, () => true)

    expect(contentPacks.iconThemes.list()).toEqual([])
  })
})
