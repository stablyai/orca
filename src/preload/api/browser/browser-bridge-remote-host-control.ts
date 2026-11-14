import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'
import {
  DESKTOP_BROWSER_BRIDGE_HOST_DISALLOW_CHANNEL,
  DESKTOP_BROWSER_BRIDGE_HOST_NOTICE_CHANNEL,
  DESKTOP_BROWSER_BRIDGE_HOST_STOP_CHANNEL,
  type DesktopBrowserBridgeHostNotice
} from '../../../shared/desktop-browser-bridge-host-control-contract'

/** The once-per-host notice that an SSH host is controlling a browser tab, and its answers. */
export const browserRemoteHostControlApi = {
  onRemoteHostControlNotice: (
    callback: (notice: DesktopBrowserBridgeHostNotice) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      notice: DesktopBrowserBridgeHostNotice
    ): void => callback(notice)
    ipcRenderer.on(DESKTOP_BROWSER_BRIDGE_HOST_NOTICE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(DESKTOP_BROWSER_BRIDGE_HOST_NOTICE_CHANNEL, listener)
  },
  stopRemoteHostControl: (targetId: string): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_BROWSER_BRIDGE_HOST_STOP_CHANNEL, targetId),
  disallowRemoteHostControl: (targetId: string): Promise<boolean> =>
    ipcRenderer.invoke(DESKTOP_BROWSER_BRIDGE_HOST_DISALLOW_CHANNEL, targetId)
} satisfies Partial<PreloadApi['browser']>
