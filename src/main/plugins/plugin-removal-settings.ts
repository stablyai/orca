import { pluginThemeSettingsAfterRemoval } from '../../shared/plugin-theme-settings'
import { normalizePluginIdList } from '../../shared/plugins/approval/plugin-consent-state'
import type { Store } from '../persistence/loading-store/store'

/**
 * Forgets a removed plugin's consent, disabled flag, allowed external hosts and theme choices.
 * `keepDisabled`: Orca republishes a copy it ships on the next launch; that copy comes back off.
 */
export function clearRemovedPluginSettings(
  store: Pick<Store, 'getSettings' | 'updateSettings'>,
  pluginKey: string,
  { keepDisabled = false }: { keepDisabled?: boolean } = {}
): void {
  const settings = store.getSettings()
  const consents = { ...settings.pluginConsents }
  delete consents[pluginKey]
  const pluginExternalHostGrants = { ...settings.pluginExternalHostGrants }
  delete pluginExternalHostGrants[pluginKey]
  const disabledPlugins = [
    ...normalizePluginIdList(settings.disabledPlugins).filter((key) => key !== pluginKey),
    ...(keepDisabled ? [pluginKey] : [])
  ]
  store.updateSettings(
    {
      pluginConsents: consents,
      disabledPlugins,
      pluginExternalHostGrants,
      ...pluginThemeSettingsAfterRemoval(settings, pluginKey)
    },
    // Why no origin: the uninstalling window must also drop the plugin's theme choices.
    { notifyListeners: true }
  )
}
