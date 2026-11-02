import { BrowserWindow, ipcMain } from 'electron'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { sendScrcpyTouch, type ScrcpyTouchPhase } from '../emulator/android/scrcpy-control-input'

type ScrcpyTouchMessage = { deviceId: string; type: ScrcpyTouchPhase; x: number; y: number }

const TOUCH_PHASES: ReadonlySet<unknown> = new Set<ScrcpyTouchPhase>(['begin', 'move', 'end'])

function isUnitCoordinate(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1
}

function isScrcpyTouchMessage(value: unknown): value is ScrcpyTouchMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'deviceId' in value &&
    'type' in value &&
    'x' in value &&
    'y' in value &&
    typeof value.deviceId === 'string' &&
    TOUCH_PHASES.has(value.type) &&
    isUnitCoordinate(value.x) &&
    isUnitCoordinate(value.y)
  )
}

// Live Android pane touches, one fire-and-forget message per pointer phase, so drags reach
// the scrcpy control socket as they happen instead of being replayed on release.
export function registerEmulatorScrcpyTouchHandler(): void {
  ipcMain.removeAllListeners('emulator:scrcpyTouch')
  ipcMain.on('emulator:scrcpyTouch', (event, touch: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender) || !isScrcpyTouchMessage(touch)) {
      return
    }
    // No adb fallback per phase: a v2.4 server stops its video when the control socket ends,
    // so a pane that still streams has a live socket, and adb would add ~150 ms per event.
    const control = scrcpyVideoRegistry.control(touch.deviceId)
    if (control) {
      sendScrcpyTouch(control, touch.type, touch.x, touch.y)
    }
  })
}
