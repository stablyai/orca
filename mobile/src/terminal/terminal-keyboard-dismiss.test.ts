import { describe, expect, it, vi } from 'vitest'

import { dismissTerminalKeyboard } from './terminal-keyboard-dismiss'

describe('dismissTerminalKeyboard', () => {
  it('clears pending live input focus before blur and dismiss', () => {
    const calls: string[] = []
    const clearPendingLiveInputFocus = vi.fn(() => calls.push('clear'))
    const liveInput = { blur: vi.fn(() => calls.push('live-blur')) }
    const commandInput = { blur: vi.fn(() => calls.push('command-blur')) }
    const dismissKeyboard = vi.fn(() => calls.push('dismiss'))

    dismissTerminalKeyboard({
      clearPendingLiveInputFocus,
      commandInput,
      dismissKeyboard,
      liveInput
    })

    expect(calls).toEqual(['clear', 'live-blur', 'command-blur', 'dismiss'])
  })

  it('blurs both live and buffered command inputs', () => {
    const liveInput = { blur: vi.fn() }
    const commandInput = { blur: vi.fn() }

    dismissTerminalKeyboard({
      clearPendingLiveInputFocus: vi.fn(),
      commandInput,
      dismissKeyboard: vi.fn(),
      liveInput
    })

    expect(liveInput.blur).toHaveBeenCalledTimes(1)
    expect(commandInput.blur).toHaveBeenCalledTimes(1)
  })

  it('dismisses the keyboard without a live input handle', () => {
    const commandInput = { blur: vi.fn() }
    const dismissKeyboard = vi.fn()

    dismissTerminalKeyboard({
      clearPendingLiveInputFocus: vi.fn(),
      commandInput,
      dismissKeyboard,
      liveInput: null
    })

    expect(commandInput.blur).toHaveBeenCalledTimes(1)
    expect(dismissKeyboard).toHaveBeenCalledTimes(1)
  })

  it('dismisses the keyboard without a buffered command input handle', () => {
    const liveInput = { blur: vi.fn() }
    const dismissKeyboard = vi.fn()

    dismissTerminalKeyboard({
      clearPendingLiveInputFocus: vi.fn(),
      commandInput: undefined,
      dismissKeyboard,
      liveInput
    })

    expect(liveInput.blur).toHaveBeenCalledTimes(1)
    expect(dismissKeyboard).toHaveBeenCalledTimes(1)
  })

  it('still clears focus and dismisses when both input handles are missing', () => {
    const calls: string[] = []
    const clearPendingLiveInputFocus = vi.fn(() => calls.push('clear'))
    const dismissKeyboard = vi.fn(() => calls.push('dismiss'))

    dismissTerminalKeyboard({
      clearPendingLiveInputFocus,
      commandInput: undefined,
      dismissKeyboard,
      liveInput: null
    })

    expect(calls).toEqual(['clear', 'dismiss'])
  })
})
