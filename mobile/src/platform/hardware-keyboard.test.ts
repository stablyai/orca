import { describe, expect, it } from 'vitest'
import {
  reduceHardwareKeyboardState,
  resolveHardwareKeyboardAttached,
  type HardwareKeyboardState
} from './hardware-keyboard'

describe('hardware keyboard state', () => {
  it('attaches after a key event arrives without a visible IME', () => {
    const state = reduceHardwareKeyboardState(
      { keyboardVisible: false, lastImeHeight: 0, hasReceivedHardwareKeyEvent: false },
      { type: 'key-press' }
    )
    expect(resolveHardwareKeyboardAttached(state)).toBe(true)
  })

  it('does not classify software-keyboard input as hardware input', () => {
    let state: HardwareKeyboardState = {
      keyboardVisible: false,
      lastImeHeight: 0,
      hasReceivedHardwareKeyEvent: false
    }
    state = reduceHardwareKeyboardState(state, { type: 'ime-shown', height: 300 })
    state = reduceHardwareKeyboardState(state, { type: 'key-press' })
    expect(resolveHardwareKeyboardAttached(state)).toBe(false)
  })
})
