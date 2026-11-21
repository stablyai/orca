import { describe, expect, it } from 'vitest'
import { planEmulatorTextInput } from './emulator-text-input-plan'

describe('planEmulatorTextInput', () => {
  it('types US keyboard text as keys only on a US hardware layout', () => {
    expect(planEmulatorTextInput('user@example.com\n', { paste: false, usKeys: true })).toEqual({
      kind: 'keys'
    })
    expect(planEmulatorTextInput('user@example.com', { paste: false, usKeys: false })).toEqual({
      kind: 'paste',
      text: 'user@example.com',
      enterCount: 0
    })
  })

  it('pastes text a key press cannot make and keeps trailing newlines as Enter', () => {
    expect(planEmulatorTextInput('Merhaba şğü 中文\r\n\n', { paste: false, usKeys: true })).toEqual(
      { kind: 'paste', text: 'Merhaba şğü 中文', enterCount: 2 }
    )
  })

  it('pastes a pane paste whole, newlines included', () => {
    expect(planEmulatorTextInput('line one\r\nline two\n', { paste: true, usKeys: true })).toEqual({
      kind: 'paste',
      text: 'line one\nline two\n',
      enterCount: 0
    })
  })
})
