import { ipcMain, BrowserWindow } from 'electron'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { nativeAndroidSessions } from '../emulator/android/emulator-grpc-session'
import { sendScrcpyKeyboard } from '../emulator/android/scrcpy-control-input'

type ScrcpyKeyboardInput =
  | { deviceId: string; text: string }
  | { deviceId: string; key: string; shift: boolean; ctrl?: boolean }

/** Accept text or named keys, treating modifier flags as enabled only when explicitly true. */
function parseScrcpyKeyboardInput(value: unknown): ScrcpyKeyboardInput | null {
  if (typeof value !== 'object' || value === null || !('deviceId' in value)) {
    return null
  }
  const { deviceId } = value
  if (typeof deviceId !== 'string') {
    return null
  }
  if ('text' in value && typeof value.text === 'string') {
    return { deviceId, text: value.text }
  }
  if ('key' in value && typeof value.key === 'string') {
    return {
      deviceId,
      key: value.key,
      shift: 'shift' in value && value.shift === true,
      ctrl: 'ctrl' in value && value.ctrl === true
    }
  }
  return null
}

// scrcpy InputManager injection supports editing chords even when the AVD key layout does not.
export function registerEmulatorScrcpyKeyboardHandler(): void {
  ipcMain.removeHandler('emulator:scrcpyKeyboard')
  ipcMain.handle('emulator:scrcpyKeyboard', (event, value: unknown): boolean | Promise<boolean> => {
    const input = parseScrcpyKeyboardInput(value)
    if (!BrowserWindow.fromWebContents(event.sender) || !input) {
      return false
    }
    const native = nativeAndroidSessions.get(input.deviceId)
    if (native) {
      return native.keyboard(input)
    }
    const control = scrcpyVideoRegistry.control(input.deviceId)
    if (!control) {
      return false
    }
    return sendScrcpyKeyboard(control, input)
  })
}
