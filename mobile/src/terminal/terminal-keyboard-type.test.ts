import { describe, expect, it } from 'vitest'
import {
  getTerminalCommandKeyboardType,
  getTerminalLiveInputKeyboardType
} from './terminal-keyboard-type'

describe('terminal keyboard type', () => {
  it('uses the Android system keyboard for live terminal input', () => {
    expect(getTerminalLiveInputKeyboardType('android')).toBe('default')
  })

  it('uses the Android system keyboard for buffered command input', () => {
    expect(getTerminalCommandKeyboardType('android', false)).toBe('default')
    expect(getTerminalCommandKeyboardType('android', true)).toBe('default')
  })

  it('keeps the iOS ASCII keyboard when terminal autocomplete is disabled', () => {
    expect(getTerminalLiveInputKeyboardType('ios')).toBe('ascii-capable')
    expect(getTerminalCommandKeyboardType('ios', false)).toBe('ascii-capable')
    expect(getTerminalCommandKeyboardType('ios', true)).toBe('default')
  })
})
