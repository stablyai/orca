import { ipcMain, BrowserWindow } from 'electron'
import { scrcpyVideoRegistry } from '../../emulator/scrcpy-video-registry'
import { sendScrcpyKey, sendScrcpyText } from '../../emulator/android/scrcpy-input-queue'

type ScrcpyKeyboardInput =
  | { deviceId: string; text: string; paste: boolean }
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
    return { deviceId, text: value.text, paste: 'paste' in value && value.paste === true }
  }
  if ('key' in value && typeof value.key === 'string') {
    return { deviceId, key: value.key, shift: 'shift' in value && value.shift === true }
  }
  return null
}

// Live Android pane typing and paste go to the same scrcpy control socket as the pane's touches
// (emulator-scrcpy-touch.ts); keys can wait up to a paste's settle time while touches go at once.
export function registerEmulatorScrcpyKeyboardHandler(): void {
  ipcMain.removeHandler('emulator:scrcpyKeyboard')
  ipcMain.handle('emulator:scrcpyKeyboard', async (event, value: unknown): Promise<boolean> => {
    const input = parseScrcpyKeyboardInput(value)
    if (!BrowserWindow.fromWebContents(event.sender) || !input) {
      return false
    }
    const control = scrcpyVideoRegistry.control(input.deviceId)
    if (!control) {
      return false
    }
    // Text and keys share one queue per device, so a key pressed during a paste lands after it.
    const sent =
      'text' in input
        ? sendScrcpyText(control, input.text, { paste: input.paste })
        : sendScrcpyKey(control, input.key, { shift: input.shift })
    return sent.catch(() => false)
  })
}
