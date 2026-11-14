import { describe, expect, it } from 'vitest'
import { getTerminalLiveAccessoryLocalEditText } from './terminal-live-text-commit'

describe('terminal live accessory local edit text', () => {
  it.each([
    ['backspace', 'a🙂b', { start: 3, end: 3 }, 'ab'],
    ['delete', 'a🙂b', { start: 1, end: 1 }, 'ab'],
    ['backspace', '可是你好', { start: 1, end: 3 }, '可好']
  ] as const)(
    'edits %s in %j at its native UTF-16 selection',
    (localEdit, fieldText, selection, expected) => {
      expect(getTerminalLiveAccessoryLocalEditText({ localEdit, fieldText, selection })).toBe(
        expected
      )
    }
  )
})
