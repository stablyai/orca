import { describe, expect, it } from 'vitest'
import {
  submitMobileChatHardwareReturn,
  submitMobileChatKeyboardEvent
} from './mobile-chat-keyboard-submit'

function press(
  overrides: Partial<Parameters<typeof submitMobileChatKeyboardEvent>[0]> = {},
  settings: Partial<Parameters<typeof submitMobileChatKeyboardEvent>[1]> = {}
) {
  const sent: boolean[] = []
  const key = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...overrides
  }
  submitMobileChatKeyboardEvent(key, {
    enterToSend: true,
    composing: false,
    dictating: false,
    primaryModifier: 'Meta',
    submit: (alternate) => sent.push(alternate),
    ...settings
  })
  return { sent, newline: !key.defaultPrevented }
}

describe('mobile chat hardware Return boundary', () => {
  it('accepts native hardware provenance only while enabled and outside composition or dictation', () => {
    const sent: boolean[] = []
    const options = {
      enterToSend: true,
      composing: false,
      dictating: false,
      submit: (alternate: boolean) => sent.push(alternate)
    }
    submitMobileChatHardwareReturn(options)
    submitMobileChatHardwareReturn({ ...options, enterToSend: false })
    submitMobileChatHardwareReturn({ ...options, composing: true })
    submitMobileChatHardwareReturn({ ...options, dictating: true })
    expect(sent).toEqual([false])
  })
  it('sends normally and consumes hardware Return when enabled', () => {
    expect(press()).toEqual({ sent: [false], newline: false })
    expect(press({ code: 'NumpadEnter' })).toEqual({ sent: [false], newline: false })
  })

  it('leaves Shift+Return and the disabled setting to insert a newline', () => {
    expect(press({ shiftKey: true })).toEqual({ sent: [], newline: true })
    expect(press({}, { enterToSend: false })).toEqual({ sent: [], newline: true })
  })

  it('never submits soft keyboard Return or dictation', () => {
    expect(press({}, { requiresNativeHardwareReturn: true })).toEqual({ sent: [], newline: true })
    expect(press({ code: '' })).toEqual({ sent: [], newline: true })
    expect(press({ code: 'Unidentified' })).toEqual({ sent: [], newline: true })
    expect(press({}, { dictating: true })).toEqual({ sent: [], newline: true })
  })

  it('does not send while IME is composing, including Safari commit Enter', () => {
    expect(press({ isComposing: true })).toEqual({ sent: [], newline: true })
    expect(press({}, { composing: true })).toEqual({ sent: [], newline: true })
    expect(press({ keyCode: 229 })).toEqual({ sent: [], newline: true })
  })

  it('preserves the alternate modifier chord and consumes held Return without sending again', () => {
    expect(press({ metaKey: true }, { enterToSend: false })).toEqual({
      sent: [true],
      newline: false
    })
    expect(press({ ctrlKey: true }, { primaryModifier: 'Control' })).toEqual({
      sent: [true],
      newline: false
    })
    expect(press({ repeat: true })).toEqual({ sent: [], newline: false })
    expect(press({ altKey: true })).toEqual({ sent: [], newline: true })
    expect(press({ defaultPrevented: true })).toEqual({ sent: [], newline: false })
  })
})
