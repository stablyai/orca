import { sendAndroidLiveGesture } from './android-live-gesture'
import { androidButtonKeycode, normalizedToDevicePixels } from './android-input-mapping'
import {
  encodeInjectKeycode,
  encodeInjectScrollEvent,
  encodeInjectText,
  encodeSetClipboard,
  encodeInjectTouchEvent,
  splitScrcpyInjectText,
  type ScrcpyTouchAction
} from './scrcpy-control-protocol'
import type { ScrcpyControlTarget } from './scrcpy-stream-session'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

// Input over a live scrcpy control socket. Every sender returns false when the session
// cannot take the event, so callers can fall back to adb shell input.

export type ScrcpyTouchPhase = EmulatorGesturePoint['type']

export type AndroidKeyboardInput =
  | { text: string }
  | { key: string; shift: boolean; ctrl?: boolean }

export function sendScrcpyKeyboard(
  control: ScrcpyControlTarget,
  value: AndroidKeyboardInput
): boolean {
  try {
    if ('text' in value) {
      return value.text.length > 1 || /[^\x20-\x7e]/.test(value.text)
        ? control.sendControl(encodeSetClipboard(value.text))
        : sendScrcpyText(control, value.text)
    }
    return sendScrcpyButton(control, value.key, value)
  } catch {
    return false
  }
}

// KEYCODE_SHIFT_LEFT and AMETA_SHIFT_ON | AMETA_SHIFT_LEFT_ON. Text fields select only while a
// SHIFT key is held, so Shift+key presses SHIFT_LEFT around the key like a hardware keyboard.
const KEYCODE_SHIFT_LEFT = 59
const META_SHIFT = 0x41

const TOUCH_ACTION: Record<ScrcpyTouchPhase, ScrcpyTouchAction> = {
  begin: 'down',
  move: 'move',
  end: 'up'
}

export function sendScrcpyTouch(
  control: ScrcpyControlTarget,
  phase: ScrcpyTouchPhase,
  x: number,
  y: number
): boolean {
  const size = control.videoSize()
  if (!size) {
    return false
  }
  const pixel = normalizedToDevicePixels(x, y, size)
  return control.sendControl(
    encodeInjectTouchEvent({
      action: TOUCH_ACTION[phase],
      x: pixel.x,
      y: pixel.y,
      screenWidth: size.width,
      screenHeight: size.height
    })
  )
}

export function sendScrcpyTap(control: ScrcpyControlTarget, x: number, y: number): boolean {
  return sendScrcpyTouch(control, 'begin', x, y) && sendScrcpyTouch(control, 'end', x, y)
}

export function sendScrcpyGesture(
  control: ScrcpyControlTarget,
  points: EmulatorGesturePoint[],
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  return sendAndroidLiveGesture(
    (phase, x, y) => sendScrcpyTouch(control, phase, x, y),
    points,
    sleep
  )
}

export function sendScrcpyText(control: ScrcpyControlTarget, text: string): boolean {
  return splitScrcpyInjectText(text).every((chunk) => control.sendControl(encodeInjectText(chunk)))
}

export function sendScrcpyButton(
  control: ScrcpyControlTarget,
  name: string,
  modifiers: { shift?: boolean; ctrl?: boolean } = {}
): boolean {
  const keycode = androidButtonKeycode(name)
  const metaState = (modifiers.shift ? META_SHIFT : 0) | (modifiers.ctrl ? 0x3000 : 0)
  const press = (action: 'down' | 'up', code: number, meta = metaState) =>
    control.sendControl(encodeInjectKeycode({ action, keycode: code, metaState: meta }))
  if (!modifiers.shift) {
    return press('down', keycode) && press('up', keycode)
  }
  return (
    press('down', KEYCODE_SHIFT_LEFT) &&
    press('down', keycode) &&
    press('up', keycode) &&
    press('up', KEYCODE_SHIFT_LEFT, 0)
  )
}

export function sendScrcpyScroll(
  control: ScrcpyControlTarget,
  x: number,
  y: number,
  horizontal: number,
  vertical: number,
  size = control.videoSize()
): boolean {
  if (!size) {
    return false
  }
  const pixel = normalizedToDevicePixels(x, y, size)
  // v2.4 encodes each axis in [-1, 1]; preserve large wheel deltas across packets.
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(horizontal), Math.abs(vertical))))
  for (let i = 0; i < steps; i++) {
    if (
      !control.sendControl(
        encodeInjectScrollEvent({
          ...pixel,
          screenWidth: size.width,
          screenHeight: size.height,
          horizontal: horizontal / steps,
          vertical: vertical / steps
        })
      )
    ) {
      return false
    }
  }
  return true
}

export function sendScrcpyDisplayScroll(
  control: ScrcpyControlTarget | null,
  display: { width: number; height: number },
  rotation: number,
  scroll: [number, number, number, number]
): boolean {
  // scrcpy 2.4 validates control positions against its 8-pixel-aligned video size.
  const width = display.width & ~7
  const height = display.height & ~7
  const size = rotation % 2 ? { width: height, height: width } : { width, height }
  return control ? sendScrcpyScroll(control, ...scroll, size) : false
}
