import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const BROWSER_EXTENSION_IPC_CHANNELS = [
  'browserExtensions:list',
  'browserExtensions:setEnabled',
  'browserExtensions:remove',
  'browserExtensions:loadUnpacked',
  'browserExtensions:reload',
  'browserExtensions:openOptions',
  'browserExtensions:reviewUpdate',
  'browserExtensions:toolbarState',
  'browserExtensions:setPinned',
  'browserExtensions:activateAction',
  'browserExtensions:pageIcon',
  'browserExtensions:sidePanels',
  'browserExtensions:sidePanelAttach',
  'browserExtensions:sidePanelClose',
  'browserExtensions:sidePanelShown',
  'browserExtensions:installFromWebStore',
  'browserExtensions:respondInstallPrompt'
] as const

export const BROWSER_EXTENSION_CONTEXT_MENU_IPC_CHANNELS = [
  'browserExtensions:contextMenuClick',
  'browserExtensions:actionContextMenu'
] as const

export function registerLazyBrowserExtensionIpcHandlers(): void {
  for (const channel of BROWSER_EXTENSION_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of BROWSER_EXTENSION_CONTEXT_MENU_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(BROWSER_EXTENSION_IPC_CHANNELS, async (ipc) => {
    const { registerBrowserExtensionHandlers } = await import('./browser-extensions')
    registerBrowserExtensionHandlers(ipc)
  })
  registerLazyIpcHandleGroup(BROWSER_EXTENSION_CONTEXT_MENU_IPC_CHANNELS, async (ipc) => {
    const { registerBrowserExtensionContextMenuHandlers } =
      await import('./browser-extension-context-menu')
    registerBrowserExtensionContextMenuHandlers(ipc)
  })
}
