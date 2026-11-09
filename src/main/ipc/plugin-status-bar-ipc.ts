import { BrowserWindow, ipcMain } from 'electron'
import type { PluginService } from '../plugins/plugin-service'
import { pluginStatusBarRevision } from '../plugins/status-bar/plugin-status-bar-state'
import { PLUGIN_STATUS_BAR_CHANGED_CHANNEL } from '../../shared/plugins/contributions/plugin-status-bar-state'

/** Desktop windows read the workers' status bar changes, then hear each new snapshot. */
export function registerPluginStatusBarHandlers(pluginService: PluginService): void {
  const { statusBar } = pluginService.options
  ipcMain.handle('plugins:statusBarState', () => statusBar?.snapshot() ?? {})
  if (!statusBar) {
    return
  }
  // Disable, removal and update all notify a change; a refresh in flight is not one of them.
  pluginService.onChanged(() =>
    statusBar.prune((pluginKey) => {
      const plugin = pluginService.findApprovedPlugin(pluginKey, true)
      return plugin ? pluginStatusBarRevision(plugin) : null
    })
  )
  statusBar.onChanged((overrides) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(PLUGIN_STATUS_BAR_CHANGED_CHANNEL, overrides)
      }
    }
  })
}
