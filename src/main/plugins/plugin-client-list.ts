import { getUserPluginsDir } from './plugin-discovery'
import { readPluginLockfile } from './plugin-install'
import { buildPluginList, type PluginListEntry } from './plugin-list-projection'
import type { PluginService } from './plugin-service'

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
  return buildPluginList(pluginService, lock)
}
