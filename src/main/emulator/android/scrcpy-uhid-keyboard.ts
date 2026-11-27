import { encodeUhidCreate, encodeUhidInput } from './scrcpy-control-protocol'
import type { ScrcpyControlTarget } from './scrcpy-stream-session'

const KEYBOARD_ID = 1
const LEFT_SHIFT_BIT = 0x02

// A boot keyboard: modifier byte, reserved byte, six key slots (usages 0-255), five LED outputs.
const KEYBOARD_REPORT_DESCRIPTOR = Buffer.from([
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x75, 0x08, 0x95, 0x01, 0x81, 0x01, 0x05, 0x08, 0x19, 0x01,
  0x29, 0x05, 0x75, 0x01, 0x95, 0x05, 0x91, 0x02, 0x75, 0x03, 0x95, 0x01, 0x91, 0x01, 0x05, 0x07,
  0x19, 0x00, 0x29, 0xff, 0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, 0x06, 0x81, 0x00, 0xc0
])

// Android registered a new UHID keyboard within 50 ms on an Android 15 emulator, and input sent
// while it reconfigures for the new keyboard is dropped, so input waits this long after creation.
export const SCRCPY_UHID_KEYBOARD_READY_MS = 250

const RELEASED = Buffer.alloc(8)
const keyboardsCreated = new WeakSet<ScrcpyControlTarget>()

/** Claims the session's one UHID keyboard; true only for the first caller, who must create it. */
export function claimScrcpyUhidKeyboard(control: ScrcpyControlTarget): boolean {
  if (keyboardsCreated.has(control)) {
    return false
  }
  keyboardsCreated.add(control)
  return true
}

/** Creates the claimed keyboard; a failed send gives the claim back so a later key retries. */
export function createScrcpyUhidKeyboard(control: ScrcpyControlTarget): boolean {
  const created = control.sendControl(encodeUhidCreate(KEYBOARD_ID, KEYBOARD_REPORT_DESCRIPTOR))
  if (!created) {
    keyboardsCreated.delete(control)
  }
  return created
}

/** Presses and releases one key on the session's UHID keyboard. */
export function pressScrcpyUhidKey(
  control: ScrcpyControlTarget,
  usage: number,
  shift: boolean
): boolean {
  const pressed = Buffer.from([shift ? LEFT_SHIFT_BIT : 0, 0, usage, 0, 0, 0, 0, 0])
  return (
    control.sendControl(encodeUhidInput(KEYBOARD_ID, pressed)) &&
    control.sendControl(encodeUhidInput(KEYBOARD_ID, RELEASED))
  )
}
