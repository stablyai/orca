import { BrowserWindow, ipcMain } from 'electron'
import type { PluginService } from '../plugins/plugin-service'
import { pluginStatusBarRevision } from '../plugins/status-bar/plugin-status-bar-state'
import { PLUGIN_CARD_FIELDS_CHANGED_CHANNEL } from '../../shared/plugins/contributions/plugin-card-fields-state'

/** Desktop windows read the fields workers set for their cards, then hear each new snapshot. */
export function registerPluginCardFieldsHandlers(pluginService: PluginService): void {
  const { cardFields } = pluginService.options
  ipcMain.handle('plugins:cardFields', () => cardFields?.snapshot() ?? {})
  if (!cardFields) {
    return
  }
  // A disabled, removed or updated plugin's fields go with it.
  pluginService.onChanged(() =>
    cardFields.prune((pluginKey) => {
      const plugin = pluginService.findApprovedPlugin(pluginKey, true)
      return plugin ? pluginStatusBarRevision(plugin) : null
    })
  )
  cardFields.onChanged((fields) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(PLUGIN_CARD_FIELDS_CHANGED_CHANNEL, fields)
      }
    }
  })
}
