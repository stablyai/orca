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

  it('keeps iOS IME keyboards available for terminal input', () => {
    expect(getTerminalLiveInputKeyboardType('ios')).toBe('default')
    expect(getTerminalCommandKeyboardType('ios', false)).toBe('default')
    expect(getTerminalCommandKeyboardType('ios', true)).toBe('default')
  })
})
