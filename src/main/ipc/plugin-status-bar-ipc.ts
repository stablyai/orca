import { BrowserWindow, ipcMain } from 'electron'
import type { PluginService } from '../plugins/plugin-service'
import { PLUGIN_STATUS_BAR_CHANGED_CHANNEL } from '../../shared/plugins/contributions/plugin-status-bar-state'

/** Desktop windows read the workers' status bar changes, then hear each new snapshot. */
export function registerPluginStatusBarHandlers(pluginService: PluginService): void {
  const { statusBar } = pluginService.options
  ipcMain.handle('plugins:statusBarState', () => statusBar?.snapshot() ?? {})
  statusBar?.onChanged((overrides) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(PLUGIN_STATUS_BAR_CHANGED_CHANNEL, overrides)
      }
    }
  })
}
