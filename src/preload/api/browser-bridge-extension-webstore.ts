import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import {
  BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL,
  BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL,
  type BrowserExtensionInstallPromptRequest,
  type BrowserExtensionInstallPromptResponse,
  type BrowserExtensionWebStoreInstallResult
} from '../../shared/browser-extension-webstore'

/** "Add from Chrome Web Store" and Orca's install/uninstall confirmation round trip. */
export const browserExtensionWebStoreApi = {
  extensionsInstallFromWebStore: (args: {
    profileId: string
    input: string
  }): Promise<BrowserExtensionWebStoreInstallResult> =>
    ipcRenderer.invoke('browserExtensions:installFromWebStore', args),
  onExtensionInstallPrompt: (
    callback: (request: BrowserExtensionInstallPromptRequest) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: BrowserExtensionInstallPromptRequest
    ): void => callback(request)
    ipcRenderer.on(BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL, listener)
    return () =>
      ipcRenderer.removeListener(BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL, listener)
  },
  onExtensionInstallPromptClosed: (
    callback: (event: { requestId: string }) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { requestId: string }): void =>
      callback(data)
    ipcRenderer.on(BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL, listener)
    return () =>
      ipcRenderer.removeListener(BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL, listener)
  },
  respondExtensionInstallPrompt: (
    response: BrowserExtensionInstallPromptResponse
  ): Promise<boolean> => ipcRenderer.invoke('browserExtensions:respondInstallPrompt', response)
} satisfies Partial<PreloadApi['browser']>
