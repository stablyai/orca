import { ipcRenderer } from 'electron'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import type { PluginConsentRequest } from '../../shared/plugins/plugin-consent-request'
import type { PluginChangeEvent } from '../../shared/plugins/plugin-change-event'
import type {
  PluginHostInstallResult,
  PluginHostInstallSource,
  PluginHostListEntry,
  PluginHostLogLine,
  PreloadApi
} from '../api-types'

export const pluginsApi = {
  list: (): Promise<PluginHostListEntry[]> => ipcRenderer.invoke('plugins:list'),
  listLanguagePacks: () => ipcRenderer.invoke('plugins:listLanguagePacks'),
  consent: (args: PluginConsentRequest): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:consent', args),
  setEnabled: (args: { pluginKey: string; enabled: boolean }): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:setEnabled', args),
  readPanelEntry: (args: {
    pluginKey: string
    panelId: string
  }): Promise<PluginPanelEntry | null> => ipcRenderer.invoke('plugins:readPanelEntry', args),
  invokeCommand: (args: { pluginKey: string; commandId: string; args?: unknown }) =>
    ipcRenderer.invoke('plugins:invokeCommand', args),
  panelAction: (args: {
    sessionToken: string
    action: string
    params?: unknown
  }): Promise<PluginPanelActionOutcome> => ipcRenderer.invoke('plugins:panelAction', args),
  install: (source: PluginHostInstallSource): Promise<PluginHostInstallResult> =>
    ipcRenderer.invoke('plugins:install', source),
  listMarketplaces: () => ipcRenderer.invoke('plugins:listMarketplaces'),
  addMarketplace: (source) => ipcRenderer.invoke('plugins:addMarketplace', source),
  removeMarketplace: (args) => ipcRenderer.invoke('plugins:removeMarketplace', args),
  refreshMarketplaces: (args = {}) => ipcRenderer.invoke('plugins:refreshMarketplaces', args),
  listMarketplacePlugins: () => ipcRenderer.invoke('plugins:listMarketplacePlugins'),
  previewMarketplacePlugin: (args) => ipcRenderer.invoke('plugins:previewMarketplacePlugin', args),
  installMarketplacePlugin: (preview) =>
    ipcRenderer.invoke('plugins:installMarketplacePlugin', preview),
  previewMarketplaceUpdate: (args) => ipcRenderer.invoke('plugins:previewMarketplaceUpdate', args),
  rollbackMarketplacePlugin: (args) =>
    ipcRenderer.invoke('plugins:rollbackMarketplacePlugin', args),
  remove: (args: { pluginKey: string }): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:remove', args),
  getLogs: (args: { pluginKey: string }): Promise<PluginHostLogLine[]> =>
    ipcRenderer.invoke('plugins:getLogs', args),
  refresh: (): Promise<PluginHostListEntry[]> => ipcRenderer.invoke('plugins:refresh'),
  onChanged: (callback): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: PluginChangeEvent): void =>
      callback(change)
    ipcRenderer.on('plugins:changed', listener)
    return () => {
      ipcRenderer.removeListener('plugins:changed', listener)
    }
  }
} satisfies PreloadApi['plugins']
