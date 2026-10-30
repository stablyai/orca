import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import {
  BROWSER_EXTENSIONS_CHANGED_CHANNEL,
  type BrowserExtensionActionResult,
  type BrowserExtensionListResult
} from '../../shared/browser-extension-types'

/** Settings › Browser › Extensions. */
export const browserExtensionsApi = {
  extensionsList: (args: { profileId: string }): Promise<BrowserExtensionListResult> =>
    ipcRenderer.invoke('browserExtensions:list', args),
  extensionsSetEnabled: (args: {
    profileId: string
    extensionId: string
    enabled: boolean
  }): Promise<BrowserExtensionActionResult> =>
    ipcRenderer.invoke('browserExtensions:setEnabled', args),
  extensionsRemove: (args: {
    profileId: string
    extensionId: string
  }): Promise<BrowserExtensionActionResult> => ipcRenderer.invoke('browserExtensions:remove', args),
  extensionsLoadUnpacked: (args: {
    profileId: string
    directory: string
  }): Promise<BrowserExtensionActionResult> =>
    ipcRenderer.invoke('browserExtensions:loadUnpacked', args),
  extensionsReload: (args: {
    profileId: string
    extensionId: string
  }): Promise<BrowserExtensionActionResult> => ipcRenderer.invoke('browserExtensions:reload', args),
  extensionsOpenOptions: (args: {
    profileId: string
    extensionId: string
  }): Promise<BrowserExtensionActionResult> =>
    ipcRenderer.invoke('browserExtensions:openOptions', args),
  extensionsReviewUpdate: (args: {
    profileId: string
    extensionId: string
  }): Promise<BrowserExtensionActionResult> =>
    ipcRenderer.invoke('browserExtensions:reviewUpdate', args),
  onExtensionsChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(BROWSER_EXTENSIONS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(BROWSER_EXTENSIONS_CHANGED_CHANNEL, listener)
  }
} satisfies Partial<PreloadApi['browser']>
