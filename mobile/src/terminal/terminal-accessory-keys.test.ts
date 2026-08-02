import { describe, expect, it } from 'vitest'

import { buildTerminalShortcutKey, TERMINAL_ACCESSORY_KEYS } from './terminal-accessory-keys'

describe('TERMINAL_ACCESSORY_KEYS', () => {
  it('sends reverse-tab with a non-repeatable Shift+Tab key', () => {
    const key = TERMINAL_ACCESSORY_KEYS.find((candidate) => candidate.id === 'shiftTab')

    expect(key).toEqual({
      id: 'shiftTab',
      label: 'Shift+Tab',
      bytes: '\x1b[Z',
      accessibilityLabel: 'Shift Tab'
    })
  })

  it('includes a non-repeatable Enter default key', () => {
    expect(TERMINAL_ACCESSORY_KEYS.find((candidate) => candidate.id === 'enter')).toEqual({
      id: 'enter',
      label: 'Enter',
      bytes: '\r',
      accessibilityLabel: 'Enter'
    })
  })

  it('includes a non-repeatable Space default key near the primary editing keys', () => {
    const ids = TERMINAL_ACCESSORY_KEYS.map((key) => key.id)

    expect(TERMINAL_ACCESSORY_KEYS.find((candidate) => candidate.id === 'space')).toEqual({
      id: 'space',
      label: 'Space',
      bytes: ' ',
      accessibilityLabel: 'Space'
    })
    expect(ids.indexOf('space')).toBeGreaterThan(ids.indexOf('shiftTab'))
    expect(ids.indexOf('space')).toBeLessThan(ids.indexOf('backspace'))
    expect(ids.indexOf('space')).toBeLessThan(ids.indexOf('delete'))
    expect(ids.indexOf('space')).toBeLessThan(ids.indexOf('arrowUp'))
  })

  it('has unique non-empty built-in ids', () => {
    const ids = TERMINAL_ACCESSORY_KEYS.map((key) => key.id)

    expect(ids.every((id) => id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps all built-in terminal keys byte-backed', () => {
    expect(TERMINAL_ACCESSORY_KEYS.every((key) => key.bytes.length > 0)).toBe(true)
  })

  it('keeps repeat behavior explicit for built-in terminal keys', () => {
    const repeatableIds = new Set([
      'backspace',
      'delete',
      'arrowUp',
      'arrowDown',
      'arrowLeft',
      'arrowRight'
    ])

    for (const key of TERMINAL_ACCESSORY_KEYS) {
      expect(key.repeatable === true).toBe(repeatableIds.has(key.id))
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

  it('builds custom Space shortcut bytes with terminal modifiers', () => {
    expect(buildTerminalShortcutKey({ key: 'space', modifiers: [] })).toEqual({
      label: 'Space',
      bytes: ' ',
      accessibilityLabel: 'Space'
    })
    expect(buildTerminalShortcutKey({ key: 'space', modifiers: ['ctrl'] })).toEqual({
      label: 'Ctrl+Space',
      bytes: '\x00',
      accessibilityLabel: 'Ctrl Space'
    })
    expect(buildTerminalShortcutKey({ key: 'space', modifiers: ['alt'] })).toEqual({
      label: 'Alt+Space',
      bytes: '\x1b ',
      accessibilityLabel: 'Alt Space'
    })
  })

  it('builds modified special-key terminal sequences', () => {
    expect(buildTerminalShortcutKey({ key: 'tab', modifiers: ['shift'] })).toEqual({
      label: 'Shift+Tab',
      bytes: '\x1b[Z',
      accessibilityLabel: 'Shift Tab'
    })
    expect(buildTerminalShortcutKey({ key: 'enter', modifiers: [] })).toEqual({
      label: 'Enter',
      bytes: '\r',
      accessibilityLabel: 'Enter'
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
