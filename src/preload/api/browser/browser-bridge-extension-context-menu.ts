import { ipcRenderer } from 'electron'
import type { BrowserExtensionContextMenuApi } from './browser-extension-context-menu-api'

export const browserExtensionContextMenuApi: BrowserExtensionContextMenuApi = {
  extensionsContextMenuClick: (args) =>
    ipcRenderer.invoke('browserExtensions:contextMenuClick', args),
  extensionsActionContextMenu: (args) =>
    ipcRenderer.invoke('browserExtensions:actionContextMenu', args)
}
