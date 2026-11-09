import type { PluginLockfile } from '../../../shared/plugins/installation/plugin-install-lockfile'
import type { Store } from '../../persistence/loading-store/store'
import { isBundledPluginKey } from '../plugin-bundled-bootstrap'
import { getPluginsDataDir, getUserPluginsDir } from '../plugin-discovery'
import { clearRemovedPluginSettings } from '../plugin-removal-settings'
import type { PluginService } from '../plugin-service'
import { readPluginLockfile, removeInstalledPlugin } from './plugin-install'

type UninstallingPluginService = Pick<
  PluginService,
  'getDiscovered' | 'removePlugin' | 'refresh'
> & {
  readonly options: Pick<PluginService['options'], 'userDataPath' | 'bundledPluginRoot'>
}

export function canRemoveInstalledPlugin(
  pluginService: Pick<PluginService, 'getDiscovered'>,
  pluginKey: string,
  lock?: PluginLockfile
): boolean {
  return (
    lock?.plugins[pluginKey]?.source.kind !== 'bundled' &&
    pluginService.getDiscovered().some((plugin) => plugin.pluginKey === pluginKey && !plugin.isDev)
  )
}

/**
 * Removes an installed plugin with its approval, disabled flag and theme choices. Shared by the
 * Plugins page and `orca plugin uninstall`; false when the key is bundled, dev-only or unknown.
 */
export async function uninstallInstalledPlugin(input: {
  pluginService: UninstallingPluginService
  store: Pick<Store, 'getSettings' | 'updateSettings'>
  pluginKey: string
  /** Electron-only cleanup (frame storage) injected so headless hosts stay Electron-free. */
  afterRemove?: (pluginKey: string) => Promise<void>
}): Promise<boolean> {
  const { pluginService, pluginKey, store } = input
  const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
  const lock = await readPluginLockfile(pluginsDir)
  if (!canRemoveInstalledPlugin(pluginService, pluginKey, lock)) {
    return false
  }
  // Why: Orca republishes a copy it ships on the next launch; it must come back off, not on.
  const { bundledPluginRoot } = pluginService.options
  const shipped =
    bundledPluginRoot !== undefined && (await isBundledPluginKey(bundledPluginRoot, pluginKey))
  await pluginService.removePlugin(pluginKey, () =>
    removeInstalledPlugin({
      pluginsDir,
      pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
      pluginKey,
      // Why before deletion: a crash mid-delete must not leave an approved half-removed plugin.
      beforeRemove: () => clearRemovedPluginSettings(store, pluginKey, { keepDisabled: shipped })
    })
  )
  await input.afterRemove?.(pluginKey)
  await pluginService.refresh()
  return true
}
