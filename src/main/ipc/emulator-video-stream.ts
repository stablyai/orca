import { ipcMain } from 'electron'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { emulatorProbe } from '../emulator/emulator-probe'

// Bridges the main-process scrcpy video registry to renderer subscribers. The
// renderer calls emulator:videoStreamStart with a deviceId; meta + H.264 access
// units arrive on emulator:videoStreamMeta / emulator:videoStreamFrame. Mirrors
// the MJPEG emulator-frame-stream handler but for the Android H.264 path.
export function registerEmulatorVideoStreamHandlers(): void {
  const unsubscribers = new Map<string, () => void>()
  const keyFor = (webContentsId: number, deviceId: string): string => `${webContentsId}:${deviceId}`

  ipcMain.handle('emulator:videoStreamStart', (event, args: { deviceId: string }) => {
    emulatorProbe('video.subscribe', { deviceId: args.deviceId })
    const owner = event.sender
    const key = keyFor(owner.id, args.deviceId)
    unsubscribers.get(key)?.()
    const unsubscribe = scrcpyVideoRegistry.subscribe(args.deviceId, (videoEvent) => {
      if (owner.isDestroyed()) {
        return
      }
      if (videoEvent.type === 'meta') {
        owner.send('emulator:videoStreamMeta', { deviceId: args.deviceId, meta: videoEvent.meta })
      } else {
        owner.send('emulator:videoStreamFrame', { deviceId: args.deviceId, ...videoEvent.frame })
      }
    })
    unsubscribers.set(key, unsubscribe)
    owner.once('destroyed', () => {
      unsubscribers.get(key)?.()
      unsubscribers.delete(key)
    })
  })

  ipcMain.handle('emulator:videoStreamStop', (event, args: { deviceId: string }) => {
    const key = keyFor(event.sender.id, args.deviceId)
    unsubscribers.get(key)?.()
    unsubscribers.delete(key)
  })
}
