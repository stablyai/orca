import { ipcMain, BrowserWindow } from 'electron'
import { scrcpyVideoRegistry } from '../../emulator/scrcpy-video-registry'
import {
  sendScrcpyHidKey,
  sendScrcpyKey,
  sendScrcpyText
} from '../../emulator/android/scrcpy-input-queue'

type HidKey = { usage: number; shift: boolean }

type ScrcpyKeyboardInput = { hid: HidKey | null } & (
  | { deviceId: string; text: string; paste: boolean }
  | { deviceId: string; key: string; shift: boolean }
)

function parseHidKey(value: object): HidKey | null {
  if (!('hid' in value) || typeof value.hid !== 'object' || value.hid === null) {
    return null
  }
  const { hid } = value
  return 'usage' in hid && Number.isInteger(hid.usage) && typeof hid.usage === 'number'
    ? { usage: hid.usage & 0xff, shift: 'shift' in hid && hid.shift === true }
    : null
}

function parseScrcpyKeyboardInput(value: unknown): ScrcpyKeyboardInput | null {
  if (typeof value !== 'object' || value === null || !('deviceId' in value)) {
    return null
  }
  const { deviceId } = value
  if (typeof deviceId !== 'string') {
    return null
  }
  const hid = parseHidKey(value)
  if ('text' in value && typeof value.text === 'string') {
    return { deviceId, hid, text: value.text, paste: 'paste' in value && value.paste === true }
  }
  if ('key' in value && typeof value.key === 'string') {
    return { deviceId, hid, key: value.key, shift: 'shift' in value && value.shift === true }
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
    const send = () =>
      'text' in input
        ? sendScrcpyText(control, input.text, { paste: input.paste })
        : sendScrcpyKey(control, input.key, { shift: input.shift })
    // A key whose US character matches the host's goes to the UHID keyboard; text/key is the fallback.
    const sent = input.hid ? sendScrcpyHidKey(control, input.hid, send) : send()
    return sent.catch(() => false)
  })
}
