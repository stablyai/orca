import { ipcRenderer } from 'electron'
import {
  NOTCH_ACKNOWLEDGE_CHANNEL,
  NOTCH_FOCUS_PANE_CHANNEL,
  NOTCH_RENDERER_READY_CHANNEL,
  NOTCH_REVEAL_PANE_CHANNEL,
  NOTCH_SET_EXPANDED_CHANNEL,
  NOTCH_SET_INTERACTIVE_CHANNEL,
  NOTCH_SNAPSHOT_CHANNEL,
  type NotchFocusPaneRequest,
  type NotchSnapshot
} from '../../shared/notch/notch-snapshot'
import type { PreloadApi } from '../api-types'

export const notchApi = {
  onSnapshot: (callback: (snapshot: NotchSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: NotchSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on(NOTCH_SNAPSHOT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(NOTCH_SNAPSHOT_CHANNEL, listener)
  },
  acknowledgePanes: (paneKeys: string[]): void => {
    ipcRenderer.send(NOTCH_ACKNOWLEDGE_CHANNEL, paneKeys)
  },
  setExpanded: (expanded: boolean): void => {
    ipcRenderer.send(NOTCH_SET_EXPANDED_CHANNEL, expanded)
  },
  setInteractive: (interactive: boolean): void => {
    ipcRenderer.send(NOTCH_SET_INTERACTIVE_CHANNEL, interactive)
  },
  focusPane: (args: NotchFocusPaneRequest): void => {
    ipcRenderer.send(NOTCH_FOCUS_PANE_CHANNEL, args)
  },
  onRevealPane: (callback: (args: NotchFocusPaneRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, args: NotchFocusPaneRequest): void =>
      callback(args)
    ipcRenderer.on(NOTCH_REVEAL_PANE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(NOTCH_REVEAL_PANE_CHANNEL, listener)
  },
  notifyRevealReady: (): void => {
    ipcRenderer.send(NOTCH_RENDERER_READY_CHANNEL)
  }
} satisfies PreloadApi['notch']
