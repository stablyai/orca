type FrameStreamData = {
  streamId: string
  deliveryId: number
  bytes: ArrayBuffer
}

type VideoStreamData = {
  streamId: string
  deliveryToken: string
  deliveryId: number
  deviceId: string
  config: boolean
  keyFrame: boolean
  bytes: ArrayBuffer
}

type EmulatorStreamIpcRenderer = Pick<Electron.IpcRenderer, 'on' | 'removeListener' | 'send'>

export function subscribeFrameStreamFrames(
  ipcRenderer: EmulatorStreamIpcRenderer,
  callback: (data: Omit<FrameStreamData, 'deliveryId'>) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, data: FrameStreamData): void => {
    try {
      callback({ streamId: data.streamId, bytes: data.bytes })
    } finally {
      ipcRenderer.send('emulator:frameStreamFrameAck', {
        streamId: data.streamId,
        deliveryId: data.deliveryId
      })
    }
  }
  ipcRenderer.on('emulator:frameStreamFrame', listener)
  return () => ipcRenderer.removeListener('emulator:frameStreamFrame', listener)
}

export function subscribeVideoStreamFrames(
  ipcRenderer: EmulatorStreamIpcRenderer,
  callback: (data: Omit<VideoStreamData, 'deliveryId' | 'deliveryToken'>) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, data: VideoStreamData): void => {
    try {
      callback({
        streamId: data.streamId,
        deviceId: data.deviceId,
        config: data.config,
        keyFrame: data.keyFrame,
        bytes: data.bytes
      })
    } finally {
      ipcRenderer.send('emulator:videoStreamFrameAck', {
        streamId: data.streamId,
        deliveryToken: data.deliveryToken,
        deliveryId: data.deliveryId
      })
    }
  }
  ipcRenderer.on('emulator:videoStreamFrame', listener)
  return () => ipcRenderer.removeListener('emulator:videoStreamFrame', listener)
}
