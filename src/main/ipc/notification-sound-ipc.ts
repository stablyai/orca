import { ipcMain } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname, normalize } from 'node:path'
import type { Store } from '../persistence/loading-store/store'
import type {
  NotificationSoundDataResult,
  NotificationSoundPathResult
} from '../../shared/notification-settings-types'
import {
  getSelectedNotificationSoundPath,
  NOTIFICATION_SOUND_MIME_BY_EXTENSION
} from './notification-sound-selection'
import { isMacosFocusActive } from '../notifications/macos-focus-state'

const MAX_NOTIFICATION_SOUND_BYTES = 10 * 1024 * 1024

export function registerNotificationSoundHandlers(store: Store): void {
  // Return paths so preload caching avoids repeat 10MB sound transfers.
  ipcMain.removeHandler('notifications:resolveSoundPath')
  ipcMain.handle(
    'notifications:resolveSoundPath',
    async (_event, options?: { force?: boolean }): Promise<NotificationSoundPathResult> => {
      // Why: Orca plays custom sounds itself (the banner is silent), so the OS cannot mute them under Focus.
      // Previews pass force so the user can still audition sounds.
      if (options?.force !== true && (await isMacosFocusActive())) {
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
