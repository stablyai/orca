import { app, BrowserWindow, systemPreferences } from 'electron'
import {
  KEYBOARD_LAYOUT_CHANGED_CHANNEL,
  type KeyboardLayoutChangeEvent
} from '../../shared/keyboard-layout-events'
import {
  invalidateMacKeyboardLayoutSnapshot,
  setMacKeyboardLayoutCacheAuthorized
} from './macos-keyboard-layout-snapshot'

const INPUT_SOURCE_CHANGED_NOTIFICATION =
  'com.apple.Carbon.TISNotifySelectedKeyboardInputSourceChanged'

export function registerMacKeyboardLayoutChangeNotifications(): () => void {
  if (process.platform !== 'darwin') {
    return () => undefined
  }

  let disposed = false
  let subscriptionId: number
  let generation = 0
  const broadcast = (event: KeyboardLayoutChangeEvent): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(KEYBOARD_LAYOUT_CHANGED_CHANNEL, event)
        }
      } catch {
        // The window can close between the liveness check and send.
      }
    }
  }
  try {
    subscriptionId = systemPreferences.subscribeNotification(
      INPUT_SOURCE_CHANGED_NOTIFICATION,
      () => {
        if (disposed) {
          return
        }
        // Reads are synchronous in main, so clearing here means the refresh below reads the new source.
        invalidateMacKeyboardLayoutSnapshot()
        const nextGeneration = ++generation
        broadcast({ phase: 'invalidated', generation: nextGeneration })
        broadcast({ phase: 'refresh', generation: nextGeneration })
      }
    )
  } catch {
    return () => undefined
  }
  setMacKeyboardLayoutCacheAuthorized(true)

  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    setMacKeyboardLayoutCacheAuthorized(false)
    app.removeListener('will-quit', dispose)
    try {
      systemPreferences.unsubscribeNotification(subscriptionId)
    } catch {
      // Native notification teardown is best-effort during process exit.
    }
  }
  app.once('will-quit', dispose)
  return dispose
}

export const MAC_KEYBOARD_INPUT_SOURCE_CHANGED_NOTIFICATION = INPUT_SOURCE_CHANGED_NOTIFICATION
