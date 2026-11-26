import { BrowserWindow, ipcMain } from 'electron'
import { PLUGIN_USAGE_PROVIDERS_CHANGED_CHANNEL } from '../../../shared/plugins/contributions/plugin-usage-provider-contribution'
import type { PluginService } from '../../plugins/plugin-service'

export function registerPluginUsageProviderHandlers(pluginService: PluginService): void {
  const { usageProviders } = pluginService
  ipcMain.handle('plugins:usageProviders', () => usageProviders.snapshot())
  usageProviders.onChanged((readings) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(PLUGIN_USAGE_PROVIDERS_CHANGED_CHANNEL, readings)
      }
    }
  })
}
