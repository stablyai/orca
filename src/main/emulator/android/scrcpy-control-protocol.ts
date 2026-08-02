// scrcpy server control protocol v2.4
// Byte-exact encoders for the scrcpy control socket. Every multi-byte field is
// big-endian to match the server's DataInputStream reads.

export const SCRCPY_CONTROL_MSG_TYPE = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4
} as const

export type ScrcpyKeyAction = 'down' | 'up'
export type ScrcpyTouchAction = 'down' | 'up' | 'move'

// AKEY_EVENT_ACTION_* / AMOTION_EVENT_ACTION_* codes the server forwards to Android.
const KEY_ACTION_CODE: Record<ScrcpyKeyAction, number> = { down: 0, up: 1 }
const TOUCH_ACTION_CODE: Record<ScrcpyTouchAction, number> = { down: 0, up: 1, move: 2 }

// AMOTION_EVENT_BUTTON_PRIMARY — scrcpy reports the primary button for touches.
const BUTTON_PRIMARY = 1
// Pressure is a u16 fixed-point value where 0xFFFF represents 1.0.
const PRESSURE_MAX = 0xffff

function encodePressure(pressure: number): number {
  const fixed = Math.round(pressure * PRESSURE_MAX)
  if (fixed < 0) {
    return 0
  }
  if (fixed > PRESSURE_MAX) {
    return PRESSURE_MAX
  }
  return fixed
}

export function encodeInjectTouchEvent(p: {
  action: ScrcpyTouchAction
  pointerId: bigint
  x: number
  y: number
  screenWidth: number
  screenHeight: number
  pressure?: number
}): Buffer {
  // A finger that lifts has no pressure; otherwise full pressure unless overridden.
  const pressure = p.pressure ?? (p.action === 'up' ? 0 : 1)
  const buf = Buffer.alloc(32)
  buf.writeUInt8(SCRCPY_CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT, 0)
  buf.writeUInt8(TOUCH_ACTION_CODE[p.action], 1)
  buf.writeBigUInt64BE(p.pointerId, 2)
  buf.writeInt32BE(p.x, 10)
  buf.writeInt32BE(p.y, 14)
  buf.writeUInt16BE(p.screenWidth, 18)
  buf.writeUInt16BE(p.screenHeight, 20)
  buf.writeUInt16BE(encodePressure(pressure), 22)
  buf.writeUInt32BE(BUTTON_PRIMARY, 24)
  buf.writeUInt32BE(p.action === 'up' ? 0 : BUTTON_PRIMARY, 28)
  return buf
}

export function encodeInjectKeycode(p: {
  action: ScrcpyKeyAction
  keycode: number
  repeat?: number
  metaState?: number
}): Buffer {
  const buf = Buffer.alloc(14)
  buf.writeUInt8(SCRCPY_CONTROL_MSG_TYPE.INJECT_KEYCODE, 0)
  buf.writeUInt8(KEY_ACTION_CODE[p.action], 1)
  buf.writeInt32BE(p.keycode, 2)
  buf.writeInt32BE(p.repeat ?? 0, 6)
  buf.writeInt32BE(p.metaState ?? 0, 10)
  return buf
}

export function encodeInjectText(text: string): Buffer {
  // The length prefix is the UTF-8 byte count, which can exceed text.length.
  const payload = Buffer.from(text, 'utf8')
  const buf = Buffer.alloc(5 + payload.length)
  buf.writeUInt8(SCRCPY_CONTROL_MSG_TYPE.INJECT_TEXT, 0)
  buf.writeUInt32BE(payload.length, 1)
  payload.copy(buf, 5)
  return buf
}

export function encodeBackOrScreenOn(action: ScrcpyKeyAction): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt8(SCRCPY_CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON, 0)
  buf.writeUInt8(KEY_ACTION_CODE[action], 1)
  return buf
}
