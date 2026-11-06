import { describe, expect, it } from 'vitest'
import {
  SCRCPY_CONTROL_MSG_TYPE,
  SCRCPY_INJECT_TEXT_MAX_BYTES,
  encodeInjectKeycode,
  encodeInjectText,
  encodeInjectTouchEvent,
  splitScrcpyInjectText
} from './scrcpy-control-protocol'

describe('encodeInjectTouchEvent', () => {
  it('encodes a touch-down event with the full 32-byte field layout', () => {
    const buf = encodeInjectTouchEvent({
      action: 'down',
      x: 100,
      y: 200,
      screenWidth: 1080,
      screenHeight: 1920
    })

    expect(buf.length).toBe(32)
    expect(buf.readUInt8(0)).toBe(2) // SC_CONTROL_MSG_TYPE_INJECT_TOUCH_EVENT
    expect(buf.readUInt8(1)).toBe(0) // AMOTION_EVENT_ACTION_DOWN
    expect(buf.readBigInt64BE(2)).toBe(-2n) // POINTER_ID_GENERIC_FINGER
    expect(buf.readInt32BE(10)).toBe(100)
    expect(buf.readInt32BE(14)).toBe(200)
    expect(buf.readUInt16BE(18)).toBe(1080)
    expect(buf.readUInt16BE(20)).toBe(1920)
    expect(buf.readUInt16BE(22)).toBe(0xffff) // default pressure 1.0 for down
    expect(buf.readUInt32BE(24)).toBe(1) // AMOTION_EVENT_BUTTON_PRIMARY
    expect(buf.readUInt32BE(28)).toBe(1) // buttons set while pressed
  })

  it('encodes move and up actions, releasing pressure and buttons on up', () => {
    const position = { x: 5, y: 6, screenWidth: 720, screenHeight: 1280 }
    const move = encodeInjectTouchEvent({ action: 'move', ...position })
    const up = encodeInjectTouchEvent({ action: 'up', ...position })

    expect(move.readUInt8(1)).toBe(2) // AMOTION_EVENT_ACTION_MOVE
    expect(move.readUInt16BE(22)).toBe(0xffff)
    expect(up.readUInt8(1)).toBe(1) // AMOTION_EVENT_ACTION_UP
    expect(up.readUInt16BE(22)).toBe(0)
    expect(up.readUInt32BE(28)).toBe(0)
  })

  it('encodes pressure as the same u16 fixed point as the official client', () => {
    const pressureField = (pressure: number): number =>
      encodeInjectTouchEvent({
        action: 'down',
        x: 0,
        y: 0,
        screenWidth: 1,
        screenHeight: 1,
        pressure
      }).readUInt16BE(22)

    expect(pressureField(0.5)).toBe(0x8000)
    expect(pressureField(2)).toBe(0xffff)
    expect(pressureField(-1)).toBe(0)
    expect(pressureField(Number.NaN)).toBe(0)
  })
})

describe('encodeInjectKeycode', () => {
  it('encodes a 14-byte keycode event with repeat and meta state', () => {
    const buf = encodeInjectKeycode({ action: 'up', keycode: 66, repeat: 3, metaState: 0x1000 })

    expect(buf.length).toBe(14)
    expect(buf.readUInt8(0)).toBe(SCRCPY_CONTROL_MSG_TYPE.INJECT_KEYCODE)
    expect(buf.readUInt8(1)).toBe(1) // AKEY_EVENT_ACTION_UP
    expect(buf.readInt32BE(2)).toBe(66)
    expect(buf.readInt32BE(6)).toBe(3)
    expect(buf.readInt32BE(10)).toBe(0x1000)
  })
})

describe('encodeInjectText', () => {
  it('prefixes the UTF-8 byte length, not the UTF-16 length', () => {
    const buf = encodeInjectText('añ')

    expect(buf.readUInt8(0)).toBe(SCRCPY_CONTROL_MSG_TYPE.INJECT_TEXT)
    expect(buf.readUInt32BE(1)).toBe(3)
    expect(buf.subarray(5).toString('utf8')).toBe('añ')
  })

  it('rejects payloads the server-side protocol would not expect', () => {
    expect(() => encodeInjectText('a'.repeat(SCRCPY_INJECT_TEXT_MAX_BYTES + 1))).toThrow(RangeError)
  })
})

describe('splitScrcpyInjectText', () => {
  it('keeps chunks within the byte limit without splitting a code point', () => {
    // 299 ASCII bytes leave room for neither the 2-byte ñ nor the 4-byte emoji.
    const text = `${'a'.repeat(299)}ñ😀${'b'.repeat(400)}`
    const chunks = splitScrcpyInjectText(text)

    expect(chunks.join('')).toBe(text)
    expect(chunks.slice(0, 2)).toEqual(['a'.repeat(299), `ñ😀${'b'.repeat(294)}`])
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(SCRCPY_INJECT_TEXT_MAX_BYTES)
      expect(() => encodeInjectText(chunk)).not.toThrow()
    }
  })

  it('returns no chunks for empty text', () => {
    expect(splitScrcpyInjectText('')).toEqual([])
  })
})
