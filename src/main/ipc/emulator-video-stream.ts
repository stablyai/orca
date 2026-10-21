import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { emulatorProbe } from '../emulator/emulator-probe'
import { abortWhenRendererGone } from './renderer-lifetime-abort'

// Bridges the main-process scrcpy video registry to renderer subscribers. The
// renderer calls emulator:videoStreamStart with a deviceId; meta + H.264 access
// units arrive on emulator:videoStreamMeta / emulator:videoStreamFrame. Mirrors
// the MJPEG emulator-frame-stream handler but for the Android H.264 path.
export function registerEmulatorVideoStreamHandlers(): void {
  type Subscription = {
    owner: WebContents
    unsubscribe: () => void
    disposeLifetime: () => void
    startTimer: ReturnType<typeof setTimeout> | null
  }
  const subscriptions = new Map<string, Subscription>()

  const stopSubscription = (streamId: string, owner?: WebContents): void => {
    const subscription = subscriptions.get(streamId)
    if (!subscription || (owner && subscription.owner !== owner)) {
      return
    }
    subscriptions.delete(streamId)
    if (subscription.startTimer !== null) {
      clearTimeout(subscription.startTimer)
    }
    subscription.disposeLifetime()
    subscription.unsubscribe()
  }

  ipcMain.handle(
    'emulator:videoStreamStart',
    (event, args: { deviceId: string; streamId?: string }) => {
      const owner = event.sender
      if (!BrowserWindow.fromWebContents(owner)) {
        throw new Error('Emulator video stream must originate from a BrowserWindow.')
      }
      if (typeof args?.deviceId !== 'string') {
        throw new Error('Emulator video stream requires a deviceId string.')
      }
      emulatorProbe('video.subscribe', { deviceId: args.deviceId })
      const streamId = args.streamId ?? randomUUID()
      const existing = subscriptions.get(streamId)
      if (existing && existing.owner !== owner) {
        throw new Error('Video stream id is already in use by another renderer')
      }
      stopSubscription(streamId, owner)
      const lifetime = abortWhenRendererGone(owner)
      const onRendererGone = (): void => stopSubscription(streamId, owner)
      const pendingSubscription: Subscription = {
        owner,
        unsubscribe: () => {},
        disposeLifetime: () => {
          lifetime.signal.removeEventListener('abort', onRendererGone)
          lifetime.dispose()
        },
        startTimer: null
      }
      subscriptions.set(streamId, pendingSubscription)
      lifetime.signal.addEventListener('abort', onRendererGone, { once: true })
      pendingSubscription.startTimer = setTimeout(() => {
        pendingSubscription.startTimer = null
        if (owner.isDestroyed() || subscriptions.get(streamId) !== pendingSubscription) {
          return
        }
        const unsubscribe = scrcpyVideoRegistry.subscribe(args.deviceId, (videoEvent) => {
          if (owner.isDestroyed()) {
            return
          }
          if (videoEvent.type === 'meta') {
            owner.send('emulator:videoStreamMeta', {
              streamId,
              deviceId: args.deviceId,
              meta: videoEvent.meta
            })
          } else {
            owner.send('emulator:videoStreamFrame', {
              streamId,
              deviceId: args.deviceId,
              ...videoEvent.frame
            })
          }
        })
        pendingSubscription.unsubscribe = unsubscribe
      }, 0)
      return { streamId }
    }
  )

  ipcMain.handle('emulator:videoStreamStop', (event, args: { streamId: string }) => {
    stopSubscription(args.streamId, event.sender)
  })
}
