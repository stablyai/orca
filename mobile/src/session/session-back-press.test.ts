import { describe, expect, it, vi } from 'vitest'
import { createSessionBackPressHandler, resolveSessionBackPress } from './session-back-press'

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

  it('routes hardware-keyboard back to Escape', () => {
    const sendEscape = vi.fn()
    const requestLeave = vi.fn()
    const handleBackPress = createSessionBackPressHandler({
      hardwareKeyboard: true,
      isLiveInputFocused: () => true,
      requestLeave,
      sendEscape
    })

    expect(handleBackPress()).toBe(true)
    expect(sendEscape).toHaveBeenCalledOnce()
    expect(requestLeave).not.toHaveBeenCalled()
  })

  it('routes other back presses to session leave', () => {
    const sendEscape = vi.fn()
    const requestLeave = vi.fn()
    const handleBackPress = createSessionBackPressHandler({
      hardwareKeyboard: false,
      isLiveInputFocused: () => true,
      requestLeave,
      sendEscape
    })

    expect(handleBackPress()).toBe(true)
    expect(requestLeave).toHaveBeenCalledOnce()
    expect(sendEscape).not.toHaveBeenCalled()
  })
})
