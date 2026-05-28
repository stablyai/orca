import { describe, expect, it } from 'vitest'

import { buildTerminalShortcutKey, TERMINAL_ACCESSORY_KEYS } from './terminal-accessory-keys'

describe('TERMINAL_ACCESSORY_KEYS', () => {
  it('sends reverse-tab with a non-repeatable Shift+Tab key', () => {
    const key = TERMINAL_ACCESSORY_KEYS.find((candidate) => candidate.label === 'Shift+Tab')

    expect(key).toEqual({
      label: 'Shift+Tab',
      bytes: '\x1b[Z',
      accessibilityLabel: 'Shift Tab'
    })
  })

  it('keeps repeat behavior explicit for built-in terminal keys', () => {
    const repeatableLabels = new Set(['⌫', 'Del', '↑', '↓', '←', '→'])

    for (const key of TERMINAL_ACCESSORY_KEYS) {
      expect(key.repeatable === true).toBe(repeatableLabels.has(key.label))
    }
  })

  it('builds Ctrl, Alt, and Shift printable shortcut bytes', () => {
    expect(buildTerminalShortcutKey({ key: 'c', modifiers: ['ctrl'] })).toEqual({
      label: 'Ctrl+C',
      bytes: '\x03',
      accessibilityLabel: 'Ctrl C'
    })
    expect(buildTerminalShortcutKey({ key: 'k', modifiers: ['ctrl', 'alt'] })).toEqual({
      label: 'Ctrl+Alt+K',
      bytes: '\x1b\x0b',
      accessibilityLabel: 'Ctrl Alt K'
    })
    expect(buildTerminalShortcutKey({ key: '1', modifiers: ['alt', 'shift'] })).toEqual({
      label: 'Alt+Shift+1',
      bytes: '\x1b!',
      accessibilityLabel: 'Alt Shift 1'
    })
  })

  it('builds modified special-key terminal sequences', () => {
    expect(buildTerminalShortcutKey({ key: 'tab', modifiers: ['shift'] })).toEqual({
      label: 'Shift+Tab',
      bytes: '\x1b[Z',
      accessibilityLabel: 'Shift Tab'
    })
    expect(buildTerminalShortcutKey({ key: 'arrowRight', modifiers: ['ctrl', 'shift'] })).toEqual({
      label: 'Ctrl+Shift+→',
      bytes: '\x1b[1;6C',
      accessibilityLabel: 'Ctrl Shift →'
    })
    expect(buildTerminalShortcutKey({ key: 'delete', modifiers: ['alt'] })).toEqual({
      label: 'Alt+Del',
      bytes: '\x1b[3;3~',
      accessibilityLabel: 'Alt Del'
    })
  })

  it('builds function-key terminal sequences', () => {
    expect(buildTerminalShortcutKey({ key: 'f1', modifiers: [] })).toEqual({
      label: 'F1',
      bytes: '\x1bOP',
      accessibilityLabel: 'F1'
    })
    expect(buildTerminalShortcutKey({ key: 'f5', modifiers: ['shift'] })).toEqual({
      label: 'Shift+F5',
      bytes: '\x1b[15;2~',
      accessibilityLabel: 'Shift F5'
    })
  })

  it('rejects control combinations that terminals cannot encode as control bytes', () => {
    expect(buildTerminalShortcutKey({ key: '1', modifiers: ['ctrl'] })).toBeNull()
  })
})
