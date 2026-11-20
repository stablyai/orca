import { describe, expect, it } from 'vitest'
import { planSimulatorTextInput } from './simulator-text-input'

describe('planSimulatorTextInput', () => {
  it('types US keyboard text as keys only on a US hardware layout', () => {
    expect(planSimulatorTextInput('user@example.com\n', true)).toEqual({ kind: 'keys' })
    expect(planSimulatorTextInput('user@example.com', false)).toEqual({
      kind: 'paste',
      text: 'user@example.com',
      enterCount: 0
    })
  })

  it('pastes text a key press cannot make and keeps trailing newlines as Enter', () => {
    expect(planSimulatorTextInput('Merhaba şğü 中文\r\n\n', true)).toEqual({
      kind: 'paste',
      text: 'Merhaba şğü 中文',
      enterCount: 2
    })
    expect(planSimulatorTextInput('\n', false)).toEqual({ kind: 'paste', text: '', enterCount: 1 })
  })
})
