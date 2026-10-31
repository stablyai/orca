import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import type {
  NotificationDispatchResult,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { getTrustedUIRendererWindow } from '../ipc/ui'
import { getEffectiveNotificationSoundId } from '../ipc/notification-sound-selection'

let soundWindow: BrowserWindow | null = null
let soundReady: Promise<unknown> | null = null
let playing = 0
const pendingPlaybacks = new Set<() => void>()
let soundDeadline: ReturnType<typeof setTimeout> | null = null

export function closeAppNotificationPresentation(): void {
  if (soundDeadline) {
    clearTimeout(soundDeadline)
  }
  soundDeadline = null
  for (const finish of pendingPlaybacks) {
    finish()
  }
  soundWindow?.destroy()
  soundWindow = null
  soundReady = null
}

/** Main-owned alerts use the same preload sound player even after the UI window closes. */
export async function presentAppNotificationResult(
  result: NotificationDispatchResult,
  settings: NotificationSettings
): Promise<void> {
  const ui = getTrustedUIRendererWindow()
  if (!result.delivered) {
    if (result.reason === 'blocked-by-system') {
      ui?.webContents.send('automations:changed', { notificationResult: result })
    }
    return
  }
  if (getEffectiveNotificationSoundId(settings) === 'system') {
    return
  }
  let window = ui
  const hidden = !window || window.isDestroyed()
  if (hidden) {
    if (!soundWindow || soundWindow.isDestroyed()) {
      soundWindow = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          autoplayPolicy: 'no-user-gesture-required'
        }
      })
      soundDeadline = setTimeout(closeAppNotificationPresentation, 35_000)
      soundReady = soundWindow.loadURL(
        'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src blob:">'
      )
    }
    window = soundWindow
  }
  playing++
  let finishPlayback: () => void = () => {}
  const closed = new Promise<void>((resolve) => {
    finishPlayback = resolve
  })
  pendingPlaybacks.add(finishPlayback)
  try {
    await Promise.race([
      closed,
      (async () => {
        if (hidden) {
          await soundReady
        }
        if (!window || window.isDestroyed()) {
          return
        }
        const volume = Number.isFinite(settings.customSoundVolume)
          ? settings.customSoundVolume
          : 100
        await window.webContents.executeJavaScript(
          `window.api.notifications.playSound(${JSON.stringify({ volume, waitUntilEnded: hidden })})`
        )
      })()
    ])
  } catch (error) {
    console.warn('[notifications] Could not play configured sound:', error)
  } finally {
    pendingPlaybacks.delete(finishPlayback)
    playing--
    if (playing === 0) {
      closeAppNotificationPresentation()
    }
  }
}
