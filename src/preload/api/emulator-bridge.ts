import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const emulatorApi = {
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
  startVideoStream: (args: { deviceId: string; streamId: string }): Promise<{ streamId: string }> =>
    ipcRenderer.invoke('emulator:videoStreamStart', args),
  stopVideoStream: (args: { streamId: string }): Promise<void> =>
    ipcRenderer.invoke('emulator:videoStreamStop', args),
  onVideoStreamMeta: (
    callback: (data: {
      streamId: string
      deviceId: string
      meta: { codecId: string; width: number; height: number }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string
        deviceId: string
        meta: { codecId: string; width: number; height: number }
      }
    ) => callback(data)
    ipcRenderer.on('emulator:videoStreamMeta', listener)
    return () => ipcRenderer.removeListener('emulator:videoStreamMeta', listener)
  },
  onVideoStreamFrame: (
    callback: (data: {
      streamId: string
      deviceId: string
      config: boolean
      keyFrame: boolean
      bytes: ArrayBuffer
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        streamId: string
        deviceId: string
        config: boolean
        keyFrame: boolean
        bytes: ArrayBuffer
      }
    ) => callback(data)
    ipcRenderer.on('emulator:videoStreamFrame', listener)
    return () => ipcRenderer.removeListener('emulator:videoStreamFrame', listener)
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
      info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
      }
    ) => callback(data)
    ipcRenderer.on('ui:emulatorAutoAttach', listener)
    return () => ipcRenderer.removeListener('ui:emulatorAutoAttach', listener)
  }
} satisfies PreloadApi['emulator']
