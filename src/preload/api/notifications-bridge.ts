import { ipcRenderer } from 'electron'
import type {
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationDispatchResult,
  NotificationPermissionStatusResult,
  NotificationSoundDataResult,
  NotificationSoundPathResult,
  NotificationSoundResult
} from '../../shared/notification-settings-types'
import type { PreloadApi } from '../api-types'

// Why: cache one shared Audio + blob URL per sound path so notifications do not re-read large files.
let cachedNotificationSound: {
  path: string
  blobUrl: string
  audio: HTMLAudioElement
} | null = null
let isNotificationSoundPlaying = false
// Why: audio.play() can reject before ended/error fires; cleanup prevents leaked listeners.
let cleanupNotificationSoundPlayback: (() => void) | null = null

function clearNotificationSoundPlaybackState(): void {
  cleanupNotificationSoundPlayback?.()
  cleanupNotificationSoundPlayback = null
  isNotificationSoundPlaying = false
}

function disposeCachedNotificationSound(): void {
  if (cachedNotificationSound) {
    clearNotificationSoundPlaybackState()
    cachedNotificationSound.audio.pause()
    cachedNotificationSound.audio.src = ''
    URL.revokeObjectURL(cachedNotificationSound.blobUrl)
    cachedNotificationSound = null
  }
}

export const notificationsApi = {
  dispatch: (args: Record<string, unknown>): Promise<NotificationDispatchResult> =>
    ipcRenderer.invoke('notifications:dispatch', args),
  dismiss: (ids: string[]): Promise<NotificationDismissResult> =>
    ipcRenderer.invoke('notifications:dismiss', ids),
  openSystemSettings: (): Promise<void> => ipcRenderer.invoke('notifications:openSystemSettings'),
  getPermissionStatus: (): Promise<NotificationPermissionStatusResult> =>
    ipcRenderer.invoke('notifications:getPermissionStatus'),
  probeDelivery: (args?: { force?: boolean }): Promise<NotificationDeliveryProbeResult> =>
    ipcRenderer.invoke('notifications:probeDelivery', args),
  playSound: async (options?: {
    force?: boolean
    volume?: number
  }): Promise<NotificationSoundResult> => {
    try {
      // Why: drop replays while still ringing; the test button passes force to always confirm.
      if (!options?.force && isNotificationSoundPlaying) {
        return { played: false, reason: 'deduped' }
      }

      const resolved = (await ipcRenderer.invoke(
        'notifications:resolveSoundPath'
      )) as NotificationSoundPathResult
      if (!resolved.ok) {
        if (cachedNotificationSound) {
          disposeCachedNotificationSound()
        }
        return { played: false, reason: resolved.reason }
      }

      let entry = cachedNotificationSound
      if (!entry || entry.path !== resolved.path) {
        const sound = (await ipcRenderer.invoke(
          'notifications:loadSound'
        )) as NotificationSoundDataResult
        if (!sound.ok) {
          disposeCachedNotificationSound()
          return { played: false, reason: sound.reason }
        }
        const arrayBuffer = new ArrayBuffer(sound.data.byteLength)
        new Uint8Array(arrayBuffer).set(sound.data)
        const blob = new Blob([arrayBuffer], { type: sound.mimeType })
        disposeCachedNotificationSound()
        const blobUrl = URL.createObjectURL(blob)
        entry = { path: sound.path, blobUrl, audio: new Audio(blobUrl) }
        cachedNotificationSound = entry
      }

      const audio = entry.audio
      // Why: restart from zero on each play so bursts replay instead of stacking copies (GNOME canberra / VS Code signal service).
      audio.currentTime = 0
      if (typeof options?.volume === 'number' && Number.isFinite(options.volume)) {
        audio.volume = Math.min(1, Math.max(0, options.volume / 100))
      }
      isNotificationSoundPlaying = true
      cleanupNotificationSoundPlayback?.()
      const release = (): void => {
        cleanup()
        if (cleanupNotificationSoundPlayback === cleanup) {
          cleanupNotificationSoundPlayback = null
        }
        isNotificationSoundPlaying = false
      }
      const cleanup = (): void => {
        audio.removeEventListener('ended', release)
        audio.removeEventListener('error', release)
      }
      cleanupNotificationSoundPlayback = cleanup
      audio.addEventListener('ended', release)
      audio.addEventListener('error', release)
      try {
        await audio.play()
      } catch {
        release()
        return { played: false, reason: 'playback-failed' }
      }
      return { played: true }
    } catch {
      clearNotificationSoundPlaybackState()
      return { played: false, reason: 'playback-failed' }
    }
  }
} satisfies PreloadApi['notifications']
