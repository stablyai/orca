import { getUserPluginsDir } from './plugin-discovery'
import { readPluginLockfile } from './plugin-install'
import { buildPluginList, type PluginListEntry } from './plugin-list-projection'
import type { PluginService } from './plugin-service'

/** Keep client listing independent of ipcMain so headless RPC can import it. */
export async function listPluginsForClients(
  pluginService: PluginService
): Promise<PluginListEntry[]> {
  await pluginService.whenReady()
  const lock = await readPluginLockfile(getUserPluginsDir(pluginService.options.userDataPath))
  return buildPluginList(pluginService, lock)
}
