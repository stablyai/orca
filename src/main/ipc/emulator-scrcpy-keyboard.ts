import { ipcMain, BrowserWindow } from 'electron'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { sendScrcpyButton, sendScrcpyText } from '../emulator/android/scrcpy-control-input'

type ScrcpyKeyboardInput =
  | { deviceId: string; text: string }
  | { deviceId: string; key: string; shift: boolean }

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
    return { deviceId, key: value.key, shift: 'shift' in value && value.shift === true }
  }
  return null
}

// Live Android pane typing and paste go to the same scrcpy control socket as the pane's
// touches (emulator-scrcpy-touch.ts), so keys and taps reach the device in the order sent.
export function registerEmulatorScrcpyKeyboardHandler(): void {
  ipcMain.removeHandler('emulator:scrcpyKeyboard')
  ipcMain.handle('emulator:scrcpyKeyboard', (event, value: unknown): boolean => {
    const input = parseScrcpyKeyboardInput(value)
    if (!BrowserWindow.fromWebContents(event.sender) || !input) {
      return false
    }
    const control = scrcpyVideoRegistry.control(input.deviceId)
    if (!control) {
      return false
    }
    try {
      return 'text' in input
        ? sendScrcpyText(control, input.text)
        : sendScrcpyButton(control, input.key, { shift: input.shift })
    } catch {
      // Unknown key names throw from the keycode table.
      return false
    }
  })
}
