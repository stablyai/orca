import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'
import {
  BROWSER_EXTENSION_SIDE_PANELS_CHANGED_CHANNEL,
  type BrowserExtensionSidePanel
} from '../../../shared/browser/extensions/browser-extension-side-panel-types'

export const browserExtensionSidePanelApi = {
  extensionsSidePanels: (): Promise<BrowserExtensionSidePanel[]> =>
    ipcRenderer.invoke('browserExtensions:sidePanels'),
  extensionsSidePanelAttach: (args: { panelId: string }): Promise<string | null> =>
    ipcRenderer.invoke('browserExtensions:sidePanelAttach', args),
  extensionsSidePanelClose: (args: { panelId: string }): Promise<void> =>
    ipcRenderer.invoke('browserExtensions:sidePanelClose', args),
  extensionsSidePanelShown: (args: { panelId: string; browserPageId: string }): Promise<void> =>
    ipcRenderer.invoke('browserExtensions:sidePanelShown', args),
  onExtensionsSidePanelsChanged: (
    callback: (panels: BrowserExtensionSidePanel[]) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      panels: BrowserExtensionSidePanel[]
    ): void => callback(panels)
    ipcRenderer.on(BROWSER_EXTENSION_SIDE_PANELS_CHANGED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(BROWSER_EXTENSION_SIDE_PANELS_CHANGED_CHANNEL, listener)
  }
} satisfies Partial<PreloadApi['browser']>
