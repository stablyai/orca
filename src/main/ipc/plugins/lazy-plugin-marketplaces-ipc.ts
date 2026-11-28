import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type { PluginService } from '../../plugins/plugin-service'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import type { PluginApproveConsent, PluginMarketplaceHandlerServices } from './plugin-marketplaces'

const PLUGIN_MARKETPLACE_IPC_CHANNELS = [
  'plugins:suggestForFileType',
  'plugins:listMarketplaces',
  'plugins:addMarketplace',
  'plugins:removeMarketplace',
  'plugins:refreshMarketplaces',
  'plugins:listMarketplacePlugins',
  'plugins:previewMarketplacePlugin',
  'plugins:installMarketplacePlugin',
  'plugins:previewMarketplaceUpdate',
  'plugins:getAutoUpdateState',
  'plugins:takeUpdateReviewNotices',
  'plugins:getInstallCounts',
  'plugins:getRollbackVersion',
  'plugins:rollbackMarketplacePlugin'
] as const

export function registerLazyPluginMarketplaceHandlers(
  pluginService: PluginService,
  services: PluginMarketplaceHandlerServices,
  getSettings: () => GlobalSettings,
  approveConsent: PluginApproveConsent
): void {
  for (const channel of PLUGIN_MARKETPLACE_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(PLUGIN_MARKETPLACE_IPC_CHANNELS, async (ipc) => {
    const { registerPluginMarketplaceHandlers } = await import('./plugin-marketplaces')
    registerPluginMarketplaceHandlers(pluginService, services, getSettings, approveConsent, ipc)
  })
}
