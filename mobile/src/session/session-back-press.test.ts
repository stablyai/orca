import { describe, expect, it } from 'vitest'
import { resolveSessionBackPress } from './session-back-press'

describe('session back press', () => {
  it('sends escape for focused hardware-keyboard terminal input', () => {
    expect(resolveSessionBackPress({ liveInputFocused: true, hardwareKeyboard: true })).toBe(
      'send-escape'
    )
  })

  it('leaves when terminal input is not focused', () => {
    expect(resolveSessionBackPress({ liveInputFocused: false, hardwareKeyboard: true })).toBe(
      'leave'
    )
  })
})
