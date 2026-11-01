import { ipcRenderer } from 'electron'
import { subscribePluginPanelPush } from './plugin-panel-push-bridge'
import type {
  PluginFrameEntry,
  PluginFrameTheme
} from '../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginHostCallOutcome } from '../../shared/plugins/frames/plugin-protocol'
import type { PluginConsentRequest } from '../../shared/plugins/approval/plugin-consent-request'
import type { PluginChangeEvent } from '../../shared/plugins/events/plugin-change-event'
import {
  PLUGIN_VIEW_REPLY_CHANNEL,
  PLUGIN_VIEW_REQUEST_CHANNEL,
  type PluginViewRequest
} from '../../shared/plugins/view/plugin-view-protocol'
import type {
  PluginAutoUpdateEvent,
  PluginHostInstallResult,
  PluginHostInstallSource,
  PluginHostListEntry,
  PluginHostLogLine,
  PreloadApi
} from '../api-types'

export const pluginsApi = {
  list: (): Promise<PluginHostListEntry[]> => ipcRenderer.invoke('plugins:list'),
  listLanguagePacks: () => ipcRenderer.invoke('plugins:listLanguagePacks'),
  listThemes: () => ipcRenderer.invoke('plugins:listThemes'),
  listTerminalThemes: () => ipcRenderer.invoke('plugins:listTerminalThemes'),
  listIconThemes: () => ipcRenderer.invoke('plugins:listIconThemes'),
  loadIconTheme: (id) => ipcRenderer.invoke('plugins:loadIconTheme', id),
  listSyntaxes: () => ipcRenderer.invoke('plugins:listSyntaxes'),
  loadSyntax: (id) => ipcRenderer.invoke('plugins:loadSyntax', id),
  consent: (args: PluginConsentRequest): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:consent', args),
  setEnabled: (args: { pluginKey: string; enabled: boolean }): Promise<PluginHostListEntry[]> =>
    ipcRenderer.invoke('plugins:setEnabled', args),
  readPanelEntry: (args: {
    pluginKey: string
    panelId: string
    theme?: PluginFrameTheme
  }): Promise<PluginFrameEntry | null> => ipcRenderer.invoke('plugins:readPanelEntry', args),
  readCustomEditorEntry: (args: {
    pluginKey: string
    editorId: string
    theme?: PluginFrameTheme
  }): Promise<PluginFrameEntry | null> => ipcRenderer.invoke('plugins:readCustomEditorEntry', args),
  readNewFileTemplate: (args: { pluginKey: string; newFileId: string }): Promise<string | null> =>
    ipcRenderer.invoke('plugins:readNewFileTemplate', args),
  invokeCommand: (args: { pluginKey: string; commandId: string; args?: unknown }) =>
    ipcRenderer.invoke('plugins:invokeCommand', args),
  panelAction: (args: {
    sessionToken: string
    action: string
    params?: unknown
  }): Promise<PluginHostCallOutcome> => ipcRenderer.invoke('plugins:panelAction', args),
  panelState: (args) => ipcRenderer.invoke('plugins:panelState', args),
  subscribePanelPush: subscribePluginPanelPush,
  getSettings: (args) => ipcRenderer.invoke('plugins:getSettings', args),
  setSetting: (args) => ipcRenderer.invoke('plugins:setSetting', args),
  panelImage: (args) => ipcRenderer.invoke('plugins:panelImage', args),
  resolveGitSource: (args) => ipcRenderer.invoke('plugins:resolveGitSource', args),
  install: (source: PluginHostInstallSource): Promise<PluginHostInstallResult> =>
    ipcRenderer.invoke('plugins:install', source),
  listMarketplaces: () => ipcRenderer.invoke('plugins:listMarketplaces'),
  addMarketplace: (source) => ipcRenderer.invoke('plugins:addMarketplace', source),
  removeMarketplace: (args) => ipcRenderer.invoke('plugins:removeMarketplace', args),
  refreshMarketplaces: (args = {}) => ipcRenderer.invoke('plugins:refreshMarketplaces', args),
  listMarketplacePlugins: () => ipcRenderer.invoke('plugins:listMarketplacePlugins'),
  suggestForFileType: (fileType, purpose) =>
    ipcRenderer.invoke('plugins:suggestForFileType', fileType, purpose),
  previewMarketplacePlugin: (args) => ipcRenderer.invoke('plugins:previewMarketplacePlugin', args),
  installMarketplacePlugin: (preview) =>
    ipcRenderer.invoke('plugins:installMarketplacePlugin', preview),
  previewMarketplaceUpdate: (args) => ipcRenderer.invoke('plugins:previewMarketplaceUpdate', args),
  rollbackMarketplacePlugin: (args) =>
    ipcRenderer.invoke('plugins:rollbackMarketplacePlugin', args),
  getRollbackVersion: (args) => ipcRenderer.invoke('plugins:getRollbackVersion', args),
  getInstalledManifest: (args) => ipcRenderer.invoke('plugins:getInstalledManifest', args),
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
  onViewRequest: (callback): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: PluginViewRequest): void =>
      callback(request)
    ipcRenderer.on(PLUGIN_VIEW_REQUEST_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(PLUGIN_VIEW_REQUEST_CHANNEL, listener)
    }
  },
  answerViewRequest: (reply) => ipcRenderer.send(PLUGIN_VIEW_REPLY_CHANNEL, reply),
  getAutoUpdateState: () => ipcRenderer.invoke('plugins:getAutoUpdateState'),
  takeUpdateReviewNotices: () => ipcRenderer.invoke('plugins:takeUpdateReviewNotices'),
  getInstallCounts: () => ipcRenderer.invoke('plugins:getInstallCounts'),
  onInstallCountsChanged: (callback): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('plugins:installCountsChanged', listener)
    return () => {
      ipcRenderer.removeListener('plugins:installCountsChanged', listener)
    }
  },
  onAutoUpdateChanged: (callback): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, change: PluginAutoUpdateEvent): void =>
      callback(change)
    ipcRenderer.on('plugins:autoUpdateChanged', listener)
    return () => {
      ipcRenderer.removeListener('plugins:autoUpdateChanged', listener)
    }
  }
} satisfies PreloadApi['plugins']
