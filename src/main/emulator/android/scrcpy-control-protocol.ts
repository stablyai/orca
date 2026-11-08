// scrcpy server control protocol v2.4 (app/src/control_msg.c in the scrcpy repository).
// Every multi-byte field is big-endian to match the server's ByteBuffer reads.

export const SCRCPY_CONTROL_MSG_TYPE = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2
} as const

export type ScrcpyKeyAction = 'down' | 'up'
export type ScrcpyTouchAction = 'down' | 'up' | 'move'

// POINTER_ID_GENERIC_FINGER (-2 as u64): the server injects it as a touchscreen finger.
export const SCRCPY_POINTER_ID_GENERIC_FINGER = BigInt.asUintN(64, -2n)
// The official client caps one inject-text message at this many UTF-8 bytes.
export const SCRCPY_INJECT_TEXT_MAX_BYTES = 300

/** The paste flag makes clipboard assignment and Android paste one ordered control message. */
export function encodeSetClipboard(text: string): Buffer {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length > (1 << 18) - 14) {
    throw new Error('Clipboard text exceeds the scrcpy protocol limit')
  }
  const packet = Buffer.alloc(14 + bytes.length)
  packet[0] = 9
  packet[9] = 1
  packet.writeUInt32BE(bytes.length, 10)
  bytes.copy(packet, 14)
  return packet
}

// AKEY_EVENT_ACTION_* / AMOTION_EVENT_ACTION_* codes the server forwards to Android.
const KEY_ACTION_CODE: Record<ScrcpyKeyAction, number> = { down: 0, up: 1 }
const TOUCH_ACTION_CODE: Record<ScrcpyTouchAction, number> = { down: 0, up: 1, move: 2 }

// AMOTION_EVENT_BUTTON_PRIMARY, as the official client sends for a primary click.
const BUTTON_PRIMARY = 1

// Matches sc_float_to_u16fp: 1.0 is 0xFFFF, anything lower is floor(pressure * 2^16).
function encodePressure(pressure: number): number {
  if (!(pressure > 0)) {
    return 0
  }
  if (pressure >= 1) {
    return 0xffff
  }
  return Math.floor(pressure * 0x10000)
}

export function encodeInjectTouchEvent(p: {
  action: ScrcpyTouchAction
  pointerId?: bigint
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
  buf.writeBigUInt64BE(p.pointerId ?? SCRCPY_POINTER_ID_GENERIC_FINGER, 2)
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

// Split on code point boundaries so no message exceeds SCRCPY_INJECT_TEXT_MAX_BYTES.
export function splitScrcpyInjectText(text: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  let chunkBytes = 0
  for (const codePoint of text) {
    const bytes = Buffer.byteLength(codePoint, 'utf8')
    if (chunkBytes + bytes > SCRCPY_INJECT_TEXT_MAX_BYTES) {
      chunks.push(chunk)
      chunk = ''
      chunkBytes = 0
    }
    chunk += codePoint
    chunkBytes += bytes
  }
  if (chunk) {
    chunks.push(chunk)
  }
  return chunks
}

export function encodeInjectText(text: string): Buffer {
  // The length prefix is the UTF-8 byte count, which can exceed text.length.
  const payload = Buffer.from(text, 'utf8')
  if (payload.length > SCRCPY_INJECT_TEXT_MAX_BYTES) {
    throw new RangeError('scrcpy inject-text payload exceeds 300 bytes; split it first')
  }
  const buf = Buffer.alloc(5 + payload.length)
  buf.writeUInt8(SCRCPY_CONTROL_MSG_TYPE.INJECT_TEXT, 0)
  buf.writeUInt32BE(payload.length, 1)
  payload.copy(buf, 5)
  return buf
}

/** Each axis uses signed 16-bit fixed point; zero buttons keeps scrolling from becoming a click. */
export function encodeInjectScrollEvent(p: {
  x: number
  y: number
  screenWidth: number
  screenHeight: number
  horizontal: number
  vertical: number
}): Buffer {
  const packet = Buffer.alloc(21)
  packet[0] = 3
  packet.writeInt32BE(p.x, 1)
  packet.writeInt32BE(p.y, 5)
  packet.writeUInt16BE(p.screenWidth, 9)
  packet.writeUInt16BE(p.screenHeight, 11)
  packet.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(p.horizontal * 32768))), 13)
  packet.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(p.vertical * 32768))), 15)
  return packet
}
