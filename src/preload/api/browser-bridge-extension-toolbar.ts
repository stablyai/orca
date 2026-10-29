import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { BrowserExtensionActionResult } from '../../shared/browser-extension-types'
import {
  BROWSER_EXTENSION_POPUP_REQUEST_CHANNEL,
  BROWSER_EXTENSION_TOOLBAR_CHANGED_CHANNEL,
  type BrowserExtensionAnchorRect,
  type BrowserExtensionPopupRequest,
  type BrowserExtensionToolbarState
} from '../../shared/browser-extension-toolbar-types'

/** The browser toolbar's extension buttons and the extension-driven tab activation round trip. */
export const browserExtensionToolbarApi = {
  extensionsToolbarState: (args: {
    browserPageId: string
  }): Promise<BrowserExtensionToolbarState | null> =>
    ipcRenderer.invoke('browserExtensions:toolbarState', args),
  extensionsSetPinned: (args: {
    profileId: string
    extensionId: string
    pinned: boolean
  }): Promise<BrowserExtensionActionResult> =>
    ipcRenderer.invoke('browserExtensions:setPinned', args),
  extensionsActivateAction: (args: {
    browserPageId: string
    extensionId: string
    anchor: BrowserExtensionAnchorRect
    popupOnly?: boolean
  }): Promise<BrowserExtensionActionResult> =>
    ipcRenderer.invoke('browserExtensions:activateAction', args),
  extensionsPageIcon: (args: { browserPageId: string }): Promise<string | null> =>
    ipcRenderer.invoke('browserExtensions:pageIcon', args),
  onExtensionsToolbarChanged: (callback: (data: { profileId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { profileId: string }): void =>
      callback(data)
    ipcRenderer.on(BROWSER_EXTENSION_TOOLBAR_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(BROWSER_EXTENSION_TOOLBAR_CHANGED_CHANNEL, listener)
  },
  onExtensionsPopupRequested: (
    callback: (request: BrowserExtensionPopupRequest) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: BrowserExtensionPopupRequest
    ): void => callback(request)
    ipcRenderer.on(BROWSER_EXTENSION_POPUP_REQUEST_CHANNEL, listener)
    return () => ipcRenderer.removeListener(BROWSER_EXTENSION_POPUP_REQUEST_CHANNEL, listener)
  },
  onRequestTabActivate: (
    callback: (data: { requestId: string; browserPageId: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { requestId: string; browserPageId: string }
    ): void => callback(data)
    ipcRenderer.on('browser:requestTabActivate', listener)
    return () => ipcRenderer.removeListener('browser:requestTabActivate', listener)
  },
  replyTabActivate: (reply: { requestId: string; error?: string }): void => {
    ipcRenderer.send('browser:tabActivateReply', reply)
  }
} satisfies Partial<PreloadApi['browser']>
