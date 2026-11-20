import { ipcMain, type WebContents } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname, normalize } from 'node:path'
import type { Store } from '../../persistence/loading-store/store'
import {
  type NotificationSoundDataResult,
  type NotificationSoundPathResult,
  usesCustomNotificationSound
} from '../../../shared/notifications/notification-settings-types'
import {
  getEffectiveNotificationSoundId,
  getSelectedNotificationSoundPath,
  NOTIFICATION_SOUND_MIME_BY_EXTENSION
} from './notification-sound-selection'
import { isNotificationFocusActive } from '../../notifications/notification-focus-state'
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

// One load listener per page; each entry asks whether its alert is still showing.
const awaitingLoad = new WeakMap<WebContents, (() => boolean)[]>()

function sendIfCustom(store: Store, renderer: WebContents): void {
  const settings = store.getSettings().notifications
  if (usesCustomNotificationSound(getEffectiveNotificationSoundId(settings))) {
    renderer.send('notifications:playDeliveredSound', settings.customSoundVolume)
  }
}

/** Plays the selected custom sound for an alert main delivered itself; the renderer owns audio. */
export function playDeliveredSound(store: Store, isLive: () => boolean): void {
  const renderer = getTrustedUIRendererWebContents()
  if (!renderer) {
    return
  }
  if (!renderer.isLoading()) {
    sendIfCustom(store, renderer)
    return
  }
  // Why: a reloading page has no listener yet, so one sound waits for it, and only for alerts still showing.
  const waiting = awaitingLoad.get(renderer)
  awaitingLoad.set(renderer, [...(waiting ?? []).filter((live) => live()), isLive])
  if (waiting) {
    return
  }
  renderer.once('did-finish-load', () => {
    const live = awaitingLoad.get(renderer)?.some((check) => check())
    awaitingLoad.delete(renderer)
    if (live) {
      sendIfCustom(store, renderer)
    }
  })
}
