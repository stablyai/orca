import { ipcRenderer } from 'electron'
import type { BrowserExtensionActionRequestedEvent } from '../../shared/browser-guest-events'
import type { BrowserExtensionsApi } from './browser-extensions-api'

function subscribe(channel: string, callback: () => void): () => void {
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const browserExtensionsApi = {
  runExtensionMenuItem: (args) => ipcRenderer.send('browser:runExtensionMenuItem', args),
  onExtensionActionRequested: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: BrowserExtensionActionRequestedEvent
    ): void => callback(data)
    ipcRenderer.on('browser:extension-action-requested', listener)
    return () => ipcRenderer.removeListener('browser:extension-action-requested', listener)
  },
  extensionActions: (args) => ipcRenderer.invoke('browser:extensionActions', args),
  onExtensionActionsChanged: (callback) => subscribe('browser:extension-actions-changed', callback),
  activateExtensionAction: (args) => ipcRenderer.send('browser:activateExtensionAction', args),
  showExtensionActionMenu: (args) => ipcRenderer.send('browser:showExtensionActionMenu', args),
  installedExtensions: () => ipcRenderer.invoke('browser:installedExtensions'),
  onInstalledExtensionsChanged: (callback) =>
    subscribe('browser:installed-extensions-changed', callback),
  setExtensionEnabled: (args) => ipcRenderer.invoke('browser:setExtensionEnabled', args),
  removeExtension: (args) => ipcRenderer.invoke('browser:removeExtension', args),
  openExtensionOptions: (args) => ipcRenderer.invoke('browser:openExtensionOptions', args)
} satisfies BrowserExtensionsApi
