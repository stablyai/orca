import { BrowserWindow, ipcMain } from 'electron'
import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { nativeAndroidSessions } from '../emulator/android/emulator-grpc-session'
import {
  sendScrcpyTouch,
  sendScrcpyScroll,
  type ScrcpyTouchPhase
} from '../emulator/android/scrcpy-control-input'

type ScrcpyTouchMessage = {
  deviceId: string
  type: ScrcpyTouchPhase
  x: number
  y: number
  pointerType?: string
}

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
    (!('pointerType' in value) ||
      value.pointerType === undefined ||
      typeof value.pointerType === 'string') &&
    TOUCH_PHASES.has(value.type) &&
    isUnitCoordinate(value.x) &&
    isUnitCoordinate(value.y)
  )
}

// Live Android pane touches, one fire-and-forget message per pointer phase, so drags reach
// the scrcpy control socket as they happen instead of being replayed on release.
export function registerEmulatorScrcpyTouchHandler(): void {
  ipcMain.removeAllListeners('emulator:scrcpyScroll')
  ipcMain.on('emulator:scrcpyScroll', (event, scroll: unknown) => {
    if (
      !BrowserWindow.fromWebContents(event.sender) ||
      typeof scroll !== 'object' ||
      !scroll ||
      !('deviceId' in scroll) ||
      typeof scroll.deviceId !== 'string' ||
      !('x' in scroll) ||
      !isUnitCoordinate(scroll.x) ||
      !('y' in scroll) ||
      !isUnitCoordinate(scroll.y) ||
      !('horizontal' in scroll) ||
      typeof scroll.horizontal !== 'number' ||
      !Number.isFinite(scroll.horizontal) ||
      !('vertical' in scroll) ||
      typeof scroll.vertical !== 'number' ||
      !Number.isFinite(scroll.vertical)
    ) {
      return
    }
    const horizontal = Math.max(-32, Math.min(32, scroll.horizontal))
    const vertical = Math.max(-32, Math.min(32, scroll.vertical))
    const native = nativeAndroidSessions.get(scroll.deviceId)
    if (native) {
      native.scroll(scroll.x, scroll.y, horizontal, vertical)
      return
    }
    const control = scrcpyVideoRegistry.control(scroll.deviceId)
    if (control) {
      sendScrcpyScroll(control, scroll.x, scroll.y, horizontal, vertical)
    }
  })
  ipcMain.removeAllListeners('emulator:scrcpyTouch')
  ipcMain.on('emulator:scrcpyTouch', (event, touch: unknown) => {
    if (!BrowserWindow.fromWebContents(event.sender) || !isScrcpyTouchMessage(touch)) {
      return
    }
    // No adb fallback per phase: a v2.4 server stops its video when the control socket ends,
    // so a pane that still streams has a live socket, and adb would add ~150 ms per event.
    const native = nativeAndroidSessions.get(touch.deviceId)
    if (native) {
      native.pointer(touch.type, touch.x, touch.y, touch.pointerType)
      return
    }
    const control = scrcpyVideoRegistry.control(touch.deviceId)
    if (control) {
      sendScrcpyTouch(control, touch.type, touch.x, touch.y)
    }
  })
}
