import { ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  NATIVE_TERMINAL_EVENT_CHANNEL,
  type NativeTerminalEvent
} from '../../shared/native-terminal-ipc'
import type { PreloadApi } from '../api-types'

export const nativeTerminalApi = {
  isSupported: () => ipcRenderer.invoke('nativeTerminal:isSupported'),
  create: (appearance, zoomFactor, accessibilityLabel) =>
    ipcRenderer.invoke('nativeTerminal:create', appearance, zoomFactor, accessibilityLabel),
  bindPty: (surfaceId, ptyId) => ipcRenderer.invoke('nativeTerminal:bindPty', surfaceId, ptyId),
  write: (surfaceId, data) => ipcRenderer.send('nativeTerminal:write', surfaceId, data),
  setFrames: (frames) => ipcRenderer.send('nativeTerminal:setFrames', frames),
  focus: (surfaceId) => ipcRenderer.send('nativeTerminal:focus', surfaceId),
  readSelection: (surfaceId) => ipcRenderer.invoke('nativeTerminal:readSelection', surfaceId),
  setAppearance: (appearance, zoomFactor) =>
    ipcRenderer.send('nativeTerminal:setAppearance', appearance, zoomFactor),
  setForwardedChords: (chords) => ipcRenderer.send('nativeTerminal:setForwardedChords', chords),
  releaseKeyboard: () => ipcRenderer.send('nativeTerminal:releaseKeyboard'),
  setSurfaceAppearance: (surfaceId, appearance, zoomFactor) =>
    ipcRenderer.send('nativeTerminal:setSurfaceAppearance', surfaceId, appearance, zoomFactor),
  bindLocalPty: (surfaceId, ptyId) =>
    ipcRenderer.send('nativeTerminal:bindLocalPty', surfaceId, ptyId),
  destroy: (surfaceId) => ipcRenderer.send('nativeTerminal:destroy', surfaceId),
  onEvent: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: NativeTerminalEvent): void =>
      callback(payload)
    ipcRenderer.on(NATIVE_TERMINAL_EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(NATIVE_TERMINAL_EVENT_CHANNEL, listener)
    }
  }
} satisfies PreloadApi['nativeTerminal']
