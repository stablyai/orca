import { ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname, normalize } from 'node:path'
import type { Store } from '../../persistence/loading-store/store'
import type {
  NotificationSoundDataResult,
  NotificationSoundPathResult
} from '../../../shared/notifications/notification-settings-types'
import {
  getSelectedNotificationSoundPath,
  NOTIFICATION_SOUND_MIME_BY_EXTENSION
} from './notification-sound-selection'
import { isNotificationFocusActive } from '../../notifications/notification-focus-state'
import { usesCustomNotificationSound } from '../../../shared/notifications/notification-settings-types'
import { getEffectiveNotificationSoundId } from './notification-sound-selection'
import { getTrustedUIRendererWebContents } from '../ui'

const MAX_NOTIFICATION_SOUND_BYTES = 10 * 1024 * 1024

export function registerNotificationSoundHandlers(store: Store): void {
  // Return paths so preload caching avoids repeat 10MB sound transfers.
  ipcMain.removeHandler('notifications:resolveSoundPath')
  ipcMain.handle(
    'notifications:resolveSoundPath',
    async (_event, options?: { force?: boolean }): Promise<NotificationSoundPathResult> => {
      // Custom audio bypasses OS notification muting; explicit previews bypass this gate.
      if (options?.force !== true && (await isNotificationFocusActive())) {
        return { ok: false, reason: 'focus-active' }
      }
      const selectedSound = getSelectedNotificationSoundPath(store.getSettings().notifications)
      if (!selectedSound.path) {
        return { ok: false, reason: selectedSound.reason ?? 'missing-path' }
      }
      const normalizedPath = normalize(selectedSound.path)
      if (!NOTIFICATION_SOUND_MIME_BY_EXTENSION.has(extname(normalizedPath).toLowerCase())) {
        return { ok: false, reason: 'unsupported-type' }
      }
      return { ok: true, path: normalizedPath }
    }
  )

  ipcMain.removeHandler('notifications:loadSound')
  ipcMain.handle('notifications:loadSound', async (): Promise<NotificationSoundDataResult> => {
    const selectedSound = getSelectedNotificationSoundPath(store.getSettings().notifications)
    if (!selectedSound.path) {
      return { ok: false, reason: selectedSound.reason ?? 'missing-path' }
    }

    const normalizedPath = normalize(selectedSound.path)

    const mimeType = NOTIFICATION_SOUND_MIME_BY_EXTENSION.get(extname(normalizedPath).toLowerCase())
    if (!mimeType) {
      return { ok: false, reason: 'unsupported-type' }
    }

    try {
      const fileStat = await stat(normalizedPath)
      if (!fileStat.isFile()) {
        return { ok: false, reason: 'invalid-path' }
      }
      if (fileStat.size > MAX_NOTIFICATION_SOUND_BYTES) {
        return { ok: false, reason: 'too-large' }
      }

      const data = await readFile(normalizedPath)
      return { ok: true, data: new Uint8Array(data), mimeType, path: normalizedPath }
    } catch {
      return { ok: false, reason: 'read-failed' }
    }
  })
}

/** Plays the selected custom sound for an alert main delivered itself; the renderer owns audio. */
export function playDeliveredSound(store: Store): void {
  const settings = store.getSettings().notifications
  const renderer = getTrustedUIRendererWebContents()
  if (!renderer || !usesCustomNotificationSound(getEffectiveNotificationSoundId(settings))) {
    return
  }
  const play = (): void =>
    renderer.send('notifications:playDeliveredSound', settings.customSoundVolume)
  // Why: a reloading page has no listener yet, so the sound waits for the page to load.
  if (renderer.isLoading()) {
    renderer.once('did-finish-load', play)
  } else {
    play()
  }
}
