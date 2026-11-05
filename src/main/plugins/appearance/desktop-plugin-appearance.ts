import { app, nativeTheme } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { PluginService } from '../plugin-service'
import { createPluginAppearanceService } from './plugin-appearance-service'

export function createDesktopPluginAppearance(store: Store, plugins: () => PluginService | null) {
  // Why here: desktop settings writes must also retarget Electron's native theme source.
  const appearance = createPluginAppearanceService(
    {
      getSettings: () => store.getSettings(),
      updateSettings: (updates) => {
        const settings = store.updateSettings(updates, { notifyListeners: true })
        nativeTheme.themeSource = settings.theme
      }
    },
    app.getPath('userData'),
    plugins
  )
  store.onSettingsChanged((updates) => appearance.settingsChanged(updates))
  return appearance
}
