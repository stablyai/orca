import { ipcRenderer } from 'electron'
import type {
  EmulatorVideoStreamStartArgs,
  EmulatorVideoStreamMetaMessage,
  EmulatorVideoStreamFrameMessage,
  EmulatorVideoStreamErrorMessage
} from '../../shared/emulator-video-stream'
import type { PreloadApi } from '../api-types'
import type {
  EmulatorControlApi,
  EmulatorControlStreamStatus
} from '../../shared/emulator-control-stream'

export const emulatorApi = {
  startControlStream: (
    args: Parameters<EmulatorControlApi['startControlStream']>[0]
  ): Promise<void> => ipcRenderer.invoke('emulator:controlStreamStart', args),
  sendControlFrame: (args: { streamId: string; bytes: Uint8Array<ArrayBuffer> }): void =>
    ipcRenderer.send('emulator:controlFrame', args),
  stopControlStream: (args: { streamId: string }): void =>
    ipcRenderer.send('emulator:controlStreamStop', args),
  onControlStreamStatus: (
    callback: (status: EmulatorControlStreamStatus) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: EmulatorControlStreamStatus) =>
      callback(status)
    ipcRenderer.on('emulator:controlStreamStatus', listener)
    return () => ipcRenderer.removeListener('emulator:controlStreamStatus', listener)
  },
  startFrameStream: (args: {
    streamUrl: string
    streamKey?: string
  }): Promise<{
    streamId: string
  }> => ipcRenderer.invoke('emulator:frameStreamStart', args),
  stopFrameStream: (args: { streamId: string }): Promise<void> =>
    ipcRenderer.invoke('emulator:frameStreamStop', args),
  onFrameStreamFrame: (
    callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; bytes: ArrayBuffer }
    ) => callback(data)
    ipcRenderer.on('emulator:frameStreamFrame', listener)
    return () => ipcRenderer.removeListener('emulator:frameStreamFrame', listener)
  },
  onFrameStreamError: (
    callback: (data: { streamId: string; message: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { streamId: string; message: string }
    ) => callback(data)
    ipcRenderer.on('emulator:frameStreamError', listener)
    return () => ipcRenderer.removeListener('emulator:frameStreamError', listener)
  },
  startVideoStream: (args: EmulatorVideoStreamStartArgs): Promise<{ streamId: string }> =>
    ipcRenderer.invoke('emulator:videoStreamStart', args),
  stopVideoStream: (args: { streamId: string }): Promise<void> =>
    ipcRenderer.invoke('emulator:videoStreamStop', args),
  onVideoStreamMeta: (callback: (data: EmulatorVideoStreamMetaMessage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: EmulatorVideoStreamMetaMessage) =>
      callback(data)
    ipcRenderer.on('emulator:videoStreamMeta', listener)
    return () => ipcRenderer.removeListener('emulator:videoStreamMeta', listener)
  },
  sendScrcpyTouch: (touch: {
    deviceId: string
    type: 'begin' | 'move' | 'end'
    x: number
    y: number
  }): void => ipcRenderer.send('emulator:scrcpyTouch', touch),
  sendScrcpyKeyboard: (
    input: { deviceId: string; text: string } | { deviceId: string; key: string; shift: boolean }
  ): Promise<boolean> => ipcRenderer.invoke('emulator:scrcpyKeyboard', input),
  onVideoStreamFrame: (callback: (data: EmulatorVideoStreamFrameMessage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: EmulatorVideoStreamFrameMessage) =>
      callback(data)
    ipcRenderer.on('emulator:videoStreamFrame', listener)
    return () => ipcRenderer.removeListener('emulator:videoStreamFrame', listener)
  },
  onVideoStreamError: (callback: (data: EmulatorVideoStreamErrorMessage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: EmulatorVideoStreamErrorMessage) =>
      callback(data)
    ipcRenderer.on('emulator:videoStreamError', listener)
    return () => ipcRenderer.removeListener('emulator:videoStreamError', listener)
  },
  onPaneFocus: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
      callback(data)
    ipcRenderer.on('emulator:pane-focus', listener)
    return () => ipcRenderer.removeListener('emulator:pane-focus', listener)
  },
  onAutoAttach: (
    callback: (data: {
      worktreeId: string
      info: {
        deviceUdid: string
        streamUrl: string
        avccStreamUrl?: string
        wsUrl: string
        axUrl?: string
      }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        info: {
          deviceUdid: string
          streamUrl: string
          avccStreamUrl?: string
          wsUrl: string
          axUrl?: string
        }
      }
    ) => callback(data)
    ipcRenderer.on('ui:emulatorAutoAttach', listener)
    return () => ipcRenderer.removeListener('ui:emulatorAutoAttach', listener)
  }
} satisfies PreloadApi['emulator']
