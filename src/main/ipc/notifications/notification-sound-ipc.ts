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
  ipcMain.removeHandler('notifications:claimDeliveredSound')
  ipcMain.handle('notifications:claimDeliveredSound', (event) => claimDeliveredSound(event.sender))

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

// Delivered alerts still owed a sound, by page; clearing an alert removes it, and playback claims the rest.
const owed = new WeakMap<WebContents, Set<string>>()
// Pages with a send queued this turn (a burst sends one) or waiting for their load to finish.
const scheduled = new WeakSet<WebContents>()

function wantsCustomSound(store: Store): boolean {
  return usesCustomNotificationSound(
    getEffectiveNotificationSoundId(store.getSettings().notifications)
  )
}

function send(store: Store, renderer: WebContents): void {
  scheduled.delete(renderer)
  if (!renderer.isDestroyed() && owed.get(renderer)?.size && wantsCustomSound(store)) {
    renderer.send(
      'notifications:playDeliveredSound',
      store.getSettings().notifications.customSoundVolume
    )
  }
}

/** Plays the selected custom sound for an alert main delivered itself; the renderer owns audio. */
export function playDeliveredSound(store: Store, notificationId: string): void {
  const renderer = getTrustedUIRendererWebContents()
  if (!renderer || !wantsCustomSound(store)) {
    return
  }
  const ids = owed.get(renderer)
  if (ids) {
    ids.add(notificationId)
  } else {
    owed.set(renderer, new Set([notificationId]))
  }
  if (scheduled.has(renderer)) {
    return
  }
  scheduled.add(renderer)
  // Why: a reloading page has no listener yet, so its sound waits for the load.
  if (renderer.isLoading()) {
    renderer.once('did-finish-load', () => send(store, renderer))
  } else {
    setImmediate(() => send(store, renderer))
  }
}

/** A cleared alert no longer earns a sound, even one already sent and loading. */
export function retireDeliveredSound(notificationId: string): void {
  const renderer = getTrustedUIRendererWebContents()
  if (renderer) {
    owed.get(renderer)?.delete(notificationId)
  }
}

/** The page asks right before playing; true only while some delivered alert is still showing. */
function claimDeliveredSound(renderer: WebContents): boolean {
  const live = (owed.get(renderer)?.size ?? 0) > 0
  owed.delete(renderer)
  return live
}

/** The retained-attention receiver's sound callbacks for main-delivered alerts. */
export function deliveredSoundHooks(store: Store): {
  onDelivered: (notificationId: string) => void
  onRetired: (notificationId: string) => void
} {
  return {
    onDelivered: (notificationId) => playDeliveredSound(store, notificationId),
    onRetired: retireDeliveredSound
  }
}
