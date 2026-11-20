import { describe, expect, it } from 'vitest'
import { planSimulatorTextInput } from './simulator-text-input'

describe('planSimulatorTextInput', () => {
  it('types US keyboard text as keys only on a US hardware layout', () => {
    expect(
      planSimulatorTextInput('user@example.com\n', { paste: false, usHardwareKeyboard: true })
    ).toEqual({ kind: 'keys' })
    expect(
      planSimulatorTextInput('user@example.com', { paste: false, usHardwareKeyboard: false })
    ).toEqual({ kind: 'paste', text: 'user@example.com', enterCount: 0 })
  })

  it('pastes text a key press cannot make and keeps trailing newlines as Enter', () => {
    expect(
      planSimulatorTextInput('Merhaba şğü 中文\r\n\n', { paste: false, usHardwareKeyboard: true })
    ).toEqual({ kind: 'paste', text: 'Merhaba şğü 中文', enterCount: 2 })
  })

  it('pastes a pane paste whole, newlines included', () => {
    expect(
      planSimulatorTextInput('line one\r\nline two\n', { paste: true, usHardwareKeyboard: true })
    ).toEqual({ kind: 'paste', text: 'line one\nline two\n', enterCount: 0 })
  })
})
