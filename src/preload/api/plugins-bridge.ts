import { ipcRenderer } from 'electron'
import type {
  PanelLiveMessageDelivery,
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import type { PluginStatusBarItemSnapshot } from '../../shared/plugins/plugin-status-bar'
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
  },
  listStatusBarItems: (): Promise<PluginStatusBarItemSnapshot[]> =>
    ipcRenderer.invoke('plugins:listStatusBarItems'),
  onStatusBarItemsChanged: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      items: PluginStatusBarItemSnapshot[]
    ): void => callback(items)
    ipcRenderer.on('plugins:statusBarItemsChanged', listener)
    return () => {
      ipcRenderer.removeListener('plugins:statusBarItemsChanged', listener)
    }
  },
  attachPanel: (args: { sessionToken: string }): Promise<boolean> =>
    ipcRenderer.invoke('plugins:attachPanel', args),
  detachPanel: (args: { sessionToken: string }): Promise<void> =>
    ipcRenderer.invoke('plugins:detachPanel', args),
  postPanelMessage: (args: {
    sessionToken: string
    message: unknown
  }): Promise<PluginPanelActionOutcome> => ipcRenderer.invoke('plugins:postPanelMessage', args),
  onPanelMessage: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      delivery: PanelLiveMessageDelivery
    ): void => callback(delivery)
    ipcRenderer.on('plugins:panelMessage', listener)
    return () => {
      ipcRenderer.removeListener('plugins:panelMessage', listener)
    }
  }
} satisfies PreloadApi['plugins']
