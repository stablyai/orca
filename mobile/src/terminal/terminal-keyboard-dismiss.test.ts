import { describe, expect, it, vi } from 'vitest'

import { dismissTerminalKeyboard } from './terminal-keyboard-dismiss'

describe('dismissTerminalKeyboard', () => {
  it('clears pending live input focus before blur and dismiss', () => {
    const calls: string[] = []
    const clearPendingLiveInputFocus = vi.fn(() => calls.push('clear'))
    const liveInput = { blur: vi.fn(() => calls.push('live-blur')) }
    const dismissKeyboard = vi.fn(() => calls.push('dismiss'))

    dismissTerminalKeyboard({ clearPendingLiveInputFocus, dismissKeyboard, liveInput })

    expect(calls).toEqual(['clear', 'live-blur', 'dismiss'])
  })

  it('still clears focus and dismisses when the input handle is missing', () => {
    const calls: string[] = []
    const clearPendingLiveInputFocus = vi.fn(() => calls.push('clear'))
    const dismissKeyboard = vi.fn(() => calls.push('dismiss'))

    dismissTerminalKeyboard({ clearPendingLiveInputFocus, dismissKeyboard, liveInput: null })

    expect(calls).toEqual(['clear', 'dismiss'])
  })
})
