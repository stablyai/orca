import { ipcRenderer } from 'electron'
import {
  NOTCH_ACKNOWLEDGE_CHANNEL,
  NOTCH_FOCUS_PANE_CHANNEL,
  NOTCH_RENDERER_READY_CHANNEL,
  NOTCH_REVEAL_PANE_CHANNEL,
  NOTCH_SET_EXPANDED_CHANNEL,
  NOTCH_SET_INTERACTIVE_CHANNEL,
  NOTCH_SNAPSHOT_CHANNEL,
  type NotchSnapshot,
  type NotchFocusPaneRequest
} from '../../../shared/notch/notch-snapshot'
import type { NotchApi } from './notch-api'

export const notchApi: NotchApi = {
  onSnapshot: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: NotchSnapshot): void =>
      listener(snapshot)
    ipcRenderer.on(NOTCH_SNAPSHOT_CHANNEL, receive)
    ipcRenderer.send('notch:ready')
    return () => ipcRenderer.removeListener(NOTCH_SNAPSHOT_CHANNEL, receive)
  },
  acknowledgePanes: (keys) => ipcRenderer.send(NOTCH_ACKNOWLEDGE_CHANNEL, keys),
  setExpanded: (expanded) => ipcRenderer.send(NOTCH_SET_EXPANDED_CHANNEL, expanded),
  setInteractive: (interactive) => ipcRenderer.send(NOTCH_SET_INTERACTIVE_CHANNEL, interactive),
  focusPane: (target) => ipcRenderer.send(NOTCH_FOCUS_PANE_CHANNEL, target),
  onRevealPane: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, target: NotchFocusPaneRequest): void =>
      listener(target)
    ipcRenderer.on(NOTCH_REVEAL_PANE_CHANNEL, receive)
    return () => ipcRenderer.removeListener(NOTCH_REVEAL_PANE_CHANNEL, receive)
  },
  notifyRevealReady: () => ipcRenderer.send(NOTCH_RENDERER_READY_CHANNEL)
}
