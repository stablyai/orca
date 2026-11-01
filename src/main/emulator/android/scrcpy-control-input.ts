import { androidButtonKeycode, normalizedToDevicePixels } from './android-input-mapping'
import {
  encodeInjectKeycode,
  encodeInjectText,
  encodeInjectTouchEvent,
  splitScrcpyInjectText,
  type ScrcpyTouchAction
} from './scrcpy-control-protocol'
import type { ScrcpyControlTarget } from './scrcpy-stream-session'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

// Input over a live scrcpy control socket. Every sender returns false when the session
// cannot take the event, so callers can fall back to adb shell input.

export type ScrcpyTouchPhase = EmulatorGesturePoint['type']

const TOUCH_ACTION: Record<ScrcpyTouchPhase, ScrcpyTouchAction> = {
  begin: 'down',
  move: 'move',
  end: 'up'
}

// Replayed gestures keep the 300 ms duration of the adb swipe they replace.
const GESTURE_DURATION_MS = 300
const GESTURE_STEP_MS = 16

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

// Follow the whole path (adb swipe only had its endpoints), subdividing sparse paths so
// the finger moves at a steady pace instead of jumping between points.
function gestureSamples(points: EmulatorGesturePoint[]): { x: number; y: number }[] {
  const segments = points.length - 1
  const stepsPerSegment = Math.max(1, Math.ceil(GESTURE_DURATION_MS / GESTURE_STEP_MS / segments))
  const samples = [{ x: points[0].x, y: points[0].y }]
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    for (let step = 1; step <= stepsPerSegment; step += 1) {
      const t = step / stepsPerSegment
      samples.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  return samples
}

export async function sendScrcpyGesture(
  control: ScrcpyControlTarget,
  points: EmulatorGesturePoint[],
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  if (points.length < 2) {
    return true
  }
  const samples = gestureSamples(points)
  const first = samples[0]
  if (!sendScrcpyTouch(control, 'begin', first.x, first.y)) {
    return false
  }
  for (let index = 1; index < samples.length; index += 1) {
    await sleep(GESTURE_STEP_MS)
    const sample = samples[index]
    const phase = index === samples.length - 1 ? 'end' : 'move'
    if (!sendScrcpyTouch(control, phase, sample.x, sample.y)) {
      return false
    }
  }
  return true
}

export function sendScrcpyText(control: ScrcpyControlTarget, text: string): boolean {
  return splitScrcpyInjectText(text).every((chunk) => control.sendControl(encodeInjectText(chunk)))
}

export function sendScrcpyButton(control: ScrcpyControlTarget, name: string): boolean {
  const keycode = androidButtonKeycode(name)
  return (
    control.sendControl(encodeInjectKeycode({ action: 'down', keycode })) &&
    control.sendControl(encodeInjectKeycode({ action: 'up', keycode }))
  )
}
