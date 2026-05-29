import { describe, expect, it } from 'vitest'
import {
  TERMINAL_LIVE_INPUT_MAX_BYTES,
  getTerminalLiveSpecialKeyBytes,
  isTerminalLiveInputWithinByteLimit
} from './terminal-live-input'

describe('terminal live input', () => {
  it('maps phone keyboard special keys to PTY bytes', () => {
    expect(getTerminalLiveSpecialKeyBytes('Backspace')).toBe('\x7f')
    expect(getTerminalLiveSpecialKeyBytes('Enter')).toBeNull()
    expect(getTerminalLiveSpecialKeyBytes('a')).toBeNull()
  })

  it('enforces the paste-sized byte budget', () => {
    expect(isTerminalLiveInputWithinByteLimit('hello')).toBe(true)
    expect(isTerminalLiveInputWithinByteLimit('x'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES))).toBe(true)
    expect(isTerminalLiveInputWithinByteLimit('x'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES + 1))).toBe(
      false
    )
    expect(
      isTerminalLiveInputWithinByteLimit('é'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES / 2 + 1))
    ).toBe(false)
  })
})
