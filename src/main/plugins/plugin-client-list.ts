import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  discoverPlugins,
  getUserPluginsDir,
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin
} from './plugin-discovery'
import { readPluginLockfile } from './plugin-install'
import { buildPluginList, type PluginListEntry } from './plugin-list-projection'
import type { PluginService } from './plugin-service'

/** Installed plugins as clients see them. With the plugin system off the service discovers
 *  nothing, so this reads the install tree on demand; that never activates or starts anything,
 *  and startup with the system off stays free of plugin I/O. */
async function discoveredForClients(
  pluginService: PluginService
): Promise<readonly DiscoveredPlugin[]> {
  if (pluginService.options.isPluginSystemEnabled()) {
    return pluginService.getDiscovered()
  }
  return discoverPlugins({
    pluginsDir: getUserPluginsDir(pluginService.options.userDataPath),
    devPluginPaths: pluginService.options.getDevPluginPaths(),
    hostVersion: pluginService.options.hostVersion
  })
}

/**
 * The plugin list paired clients see. Split out of `ipc/plugins.ts` so the runtime's
 * `plugins.list` RPC can reach it without dragging `ipcMain` into its module graph —
 * the same reason preflight and the SSH registry moved.
 */
export async function listPluginsForClients(
  pluginService: PluginService
): Promise<PluginListEntry[]> {
  await pluginService.whenReady()
  const lock = await readPluginLockfile(getUserPluginsDir(pluginService.options.userDataPath))
  return buildPluginList(pluginService, lock, await discoveredForClients(pluginService))
}

/** One installed plugin's parsed manifest, for pages that show what it declares before (or
 *  without) activation. Null when the plugin is unknown or its manifest is invalid. */
export async function readInstalledPluginManifest(
  pluginService: PluginService,
  pluginKey: string
): Promise<PluginManifest | null> {
  await pluginService.whenReady()
  const plugin = (await discoveredForClients(pluginService)).find(
    (candidate) => candidate.pluginKey === pluginKey
  )
  return plugin && !isInvalidDiscoveredPlugin(plugin) ? plugin.manifest : null
}
