import { pluginThemeSettingsAfterRemoval } from '../../../shared/plugin-theme-settings'
import { normalizePluginIdList } from '../../../shared/plugins/approval/plugin-consent-state'
import type { PluginLockfile } from '../../../shared/plugins/installation/plugin-install-lockfile'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getPluginsDataDir, getUserPluginsDir } from '../plugin-discovery'
import type { PluginService } from '../plugin-service'
import { readPluginLockfile, removeInstalledPlugin } from './plugin-install'

type UninstallingPluginService = Pick<
  PluginService,
  'getDiscovered' | 'removePlugin' | 'refresh'
> & {
  readonly options: Pick<PluginService['options'], 'userDataPath'>
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
  getSettings: () => GlobalSettings
  updateSettings: (patch: Partial<GlobalSettings>) => void
  pluginKey: string
}): Promise<boolean> {
  const { pluginService, pluginKey } = input
  const pluginsDir = getUserPluginsDir(pluginService.options.userDataPath)
  const lock = await readPluginLockfile(pluginsDir)
  if (!canRemoveInstalledPlugin(pluginService, pluginKey, lock)) {
    return false
  }
  await pluginService.removePlugin(pluginKey, () =>
    removeInstalledPlugin({
      pluginsDir,
      pluginsDataDir: getPluginsDataDir(pluginService.options.userDataPath),
      pluginKey
    })
  )
  const settings = input.getSettings()
  const consents = { ...settings.pluginConsents }
  delete consents[pluginKey]
  const disabledPlugins = normalizePluginIdList(settings.disabledPlugins).filter(
    (key) => key !== pluginKey
  )
  input.updateSettings({
    pluginConsents: consents,
    disabledPlugins,
    ...pluginThemeSettingsAfterRemoval(settings, pluginKey)
  })
  await pluginService.refresh()
  return true
}
