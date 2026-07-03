import { describe, expect, it } from 'vitest'
import {
  SCRCPY_CONTROL_MSG_TYPE,
  encodeBackOrScreenOn,
  encodeInjectKeycode,
  encodeInjectText,
  encodeInjectTouchEvent
} from './scrcpy-control-protocol'

describe('SCRCPY_CONTROL_MSG_TYPE', () => {
  it('pins the v2.4 control message type codes', () => {
    expect(SCRCPY_CONTROL_MSG_TYPE.INJECT_KEYCODE).toBe(0)
    expect(SCRCPY_CONTROL_MSG_TYPE.INJECT_TEXT).toBe(1)
    expect(SCRCPY_CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT).toBe(2)
    expect(SCRCPY_CONTROL_MSG_TYPE.INJECT_SCROLL_EVENT).toBe(3)
    expect(SCRCPY_CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON).toBe(4)
  })
})

describe('encodeInjectTouchEvent', () => {
  it('encodes a touch-down event with the full 32-byte field layout', () => {
    const buf = encodeInjectTouchEvent({
      action: 'down',
      pointerId: 0x1122334455667788n,
      x: 100,
      y: 200,
      screenWidth: 1080,
      screenHeight: 1920
    })

    expect(buf.length).toBe(32)
    expect(buf.readUInt8(0)).toBe(SCRCPY_CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT)
    expect(buf.readUInt8(0)).toBe(2)
    expect(buf.readUInt8(1)).toBe(0) // AMOTION_EVENT_ACTION_DOWN
    expect(buf.readBigUInt64BE(2)).toBe(0x1122334455667788n)
    expect(buf.readInt32BE(10)).toBe(100)
    expect(buf.readInt32BE(14)).toBe(200)
    expect(buf.readUInt16BE(18)).toBe(1080)
    expect(buf.readUInt16BE(20)).toBe(1920)
    expect(buf.readUInt16BE(22)).toBe(0xffff) // default pressure 1.0 for down
    expect(buf.readUInt32BE(24)).toBe(1) // AMOTION_EVENT_BUTTON_PRIMARY
    expect(buf.readUInt32BE(28)).toBe(1) // buttons set while pressed
  })

  it('encodes a move event with action code 2 and full default pressure', () => {
    const buf = encodeInjectTouchEvent({
      action: 'move',
      pointerId: 1n,
      x: 5,
      y: 6,
      screenWidth: 720,
      screenHeight: 1280
    })

    expect(buf.length).toBe(32)
    expect(buf.readUInt8(1)).toBe(2) // AMOTION_EVENT_ACTION_MOVE
    expect(buf.readUInt16BE(22)).toBe(0xffff)
    expect(buf.readUInt32BE(28)).toBe(1)
  })

  it('encodes an up event with zero default pressure and cleared buttons', () => {
    const buf = encodeInjectTouchEvent({
      action: 'up',
      pointerId: 1n,
      x: 5,
      y: 6,
      screenWidth: 720,
      screenHeight: 1280
    })

    expect(buf.length).toBe(32)
    expect(buf.readUInt8(1)).toBe(1) // AMOTION_EVENT_ACTION_UP
    expect(buf.readUInt16BE(22)).toBe(0) // default pressure 0 on up
    expect(buf.readUInt32BE(24)).toBe(1) // actionButton stays primary
    expect(buf.readUInt32BE(28)).toBe(0) // buttons cleared on up
  })

  it('writes negative coordinates as signed int32', () => {
    const buf = encodeInjectTouchEvent({
      action: 'move',
      pointerId: 1n,
      x: -3,
      y: -7,
      screenWidth: 1,
      screenHeight: 1
    })

    expect(buf.readInt32BE(10)).toBe(-3)
    expect(buf.readInt32BE(14)).toBe(-7)
  })

  it('encodes explicit fractional pressure as fixed-point u16', () => {
    const buf = encodeInjectTouchEvent({
      action: 'down',
      pointerId: 1n,
      x: 0,
      y: 0,
      screenWidth: 1,
      screenHeight: 1,
      pressure: 0.5
    })

    expect(buf.readUInt16BE(22)).toBe(Math.round(0.5 * 0xffff))
  })

  it('clamps pressure above 1 and below 0', () => {
    const high = encodeInjectTouchEvent({
      action: 'down',
      pointerId: 1n,
      x: 0,
      y: 0,
      screenWidth: 1,
      screenHeight: 1,
      pressure: 2
    })
    expect(high.readUInt16BE(22)).toBe(0xffff)

    const low = encodeInjectTouchEvent({
      action: 'down',
      pointerId: 1n,
      x: 0,
      y: 0,
      screenWidth: 1,
      screenHeight: 1,
      pressure: -1
    })
    expect(low.readUInt16BE(22)).toBe(0)
  })
})

describe('encodeInjectKeycode', () => {
  it('encodes a keycode-down event (14 bytes) with round-tripped fields', () => {
    const buf = encodeInjectKeycode({
      action: 'down',
      keycode: 66, // AKEYCODE_ENTER
      repeat: 3,
      metaState: 0x1000
    })

    expect(buf.length).toBe(14)
    expect(buf.readUInt8(0)).toBe(SCRCPY_CONTROL_MSG_TYPE.INJECT_KEYCODE)
    expect(buf.readUInt8(0)).toBe(0)
    expect(buf.readUInt8(1)).toBe(0) // AKEY_EVENT_ACTION_DOWN
    expect(buf.readInt32BE(2)).toBe(66)
    expect(buf.readInt32BE(6)).toBe(3)
    expect(buf.readInt32BE(10)).toBe(0x1000)
  })

  it('encodes a keycode-up event and applies repeat/metaState defaults', () => {
    const buf = encodeInjectKeycode({ action: 'up', keycode: 4 }) // AKEYCODE_BACK

    expect(buf.length).toBe(14)
    expect(buf.readUInt8(1)).toBe(1) // AKEY_EVENT_ACTION_UP
    expect(buf.readInt32BE(2)).toBe(4)
    expect(buf.readInt32BE(6)).toBe(0) // default repeat
    expect(buf.readInt32BE(10)).toBe(0) // default metaState
  })
})

describe('encodeInjectText', () => {
  it('encodes the type byte, UTF-8 byte length header, and payload', () => {
    const buf = encodeInjectText('hello')

    expect(buf.readUInt8(0)).toBe(SCRCPY_CONTROL_MSG_TYPE.INJECT_TEXT)
    expect(buf.readUInt8(0)).toBe(1)
    expect(buf.readUInt32BE(1)).toBe(5)
    expect(buf.subarray(5).toString('utf8')).toBe('hello')
    expect(buf.length).toBe(5 + 5)
  })

  it('uses UTF-8 byte length (not string length) for multi-byte characters', () => {
    const text = 'é' // one JS char, two UTF-8 bytes
    const buf = encodeInjectText(text)

    expect(text.length).toBe(1)
    expect(buf.readUInt32BE(1)).toBe(2)
    expect(buf.length).toBe(5 + 2)
    expect(buf.subarray(5).toString('utf8')).toBe('é')
  })

  it('encodes an empty string as a 5-byte header with zero length', () => {
    const buf = encodeInjectText('')

    expect(buf.length).toBe(5)
    expect(buf.readUInt32BE(1)).toBe(0)
  })
})

describe('encodeBackOrScreenOn', () => {
  it('encodes a 2-byte down message', () => {
    const buf = encodeBackOrScreenOn('down')

    expect(buf.length).toBe(2)
    expect(buf.readUInt8(0)).toBe(SCRCPY_CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON)
    expect(buf.readUInt8(0)).toBe(4)
    expect(buf.readUInt8(1)).toBe(0) // AKEY_EVENT_ACTION_DOWN
  })

  it('encodes a 2-byte up message', () => {
    const buf = encodeBackOrScreenOn('up')

    expect(buf.length).toBe(2)
    expect(buf.readUInt8(1)).toBe(1) // AKEY_EVENT_ACTION_UP
  })
})
