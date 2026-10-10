import { describe, expect, it } from 'vitest'
import { NativeDoubleTapRelay, replayDoubleTap } from './ghostty-native-terminal-double-tap'

const SHIFT = 1 << 17
const COMMAND = 1 << 20
const LEFT_SHIFT = 0x38
const RIGHT_SHIFT = 0x3c
const KEY_A = 0x00

function tap(relay: NativeDoubleTapRelay, keyCode: number, atMs: number, held = 0) {
  return [
    ...relay.process({ keyCode, modifierFlags: SHIFT | held, phase: 'press' }, atMs),
    ...relay.process({ keyCode, modifierFlags: held, phase: 'release' }, atMs + 40)
  ]
}

describe('NativeDoubleTapRelay', () => {
  it('replays two clean taps when the native view sees a double tap', () => {
    const relay = new NativeDoubleTapRelay()
    expect(tap(relay, LEFT_SHIFT, 0)).toEqual([])
    expect(
      relay.process({ keyCode: RIGHT_SHIFT, modifierFlags: SHIFT, phase: 'press' }, 150)
    ).toEqual(replayDoubleTap('Shift'))
  })

  it('is broken by a key typed between the taps, which Orca never saw', () => {
    const relay = new NativeDoubleTapRelay()
    tap(relay, LEFT_SHIFT, 0)
    relay.process({ keyCode: KEY_A, modifierFlags: 0, phase: 'other' }, 80)
    expect(tap(relay, LEFT_SHIFT, 120)).toEqual([])
  })

  it('ignores taps chorded with another modifier and taps too far apart', () => {
    const chorded = new NativeDoubleTapRelay()
    tap(chorded, LEFT_SHIFT, 0, COMMAND)
    expect(tap(chorded, LEFT_SHIFT, 120, COMMAND)).toEqual([])
    const slow = new NativeDoubleTapRelay()
    tap(slow, LEFT_SHIFT, 0)
    expect(tap(slow, LEFT_SHIFT, 1000)).toEqual([])
  })

  it('replays a bare press and release per tap, as Orca detectors expect', () => {
    expect(replayDoubleTap('Cmd')).toEqual([
      { type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'Meta', modifiers: [] },
      { type: 'keyDown', keyCode: 'Meta', modifiers: ['meta'] },
      { type: 'keyUp', keyCode: 'Meta', modifiers: [] }
    ])
  })
})
