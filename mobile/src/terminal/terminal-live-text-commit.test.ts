import { describe, expect, it } from 'vitest'
import { getTerminalLiveAccessoryLocalEditText } from './terminal-live-text-commit'

describe('terminal live accessory local edit text', () => {
  it.each([
    ['backspace', 'a🙂b', { start: 3, end: 3 }, 'ab'],
    ['delete', 'a🙂b', { start: 1, end: 1 }, 'ab'],
    ['backspace', '可是你好', { start: 1, end: 3 }, '可好'],
    ['delete', '可是你好', { start: 1, end: 3 }, '可好'],
    ['backspace', 'abc', { start: 0, end: 0 }, 'abc'],
    ['delete', 'abc', { start: 3, end: 3 }, 'abc']
  ] as const)(
    'edits %s in %j at its native UTF-16 selection',
    (localEdit, fieldText, selection, expected) => {
      expect(getTerminalLiveAccessoryLocalEditText({ localEdit, fieldText, selection })).toBe(
        expected
      )
    }
  )

  it.each([
    ['', ''],
    ['a', ''],
    ['a🙂', 'a'],
    ['🙂a', '🙂'],
    ['🙂🙂', '🙂'],
    ['a\ud800', 'a'],
    ['a\udc00', 'a'],
    ['\ud800\ud800', '\ud800'],
    ['\udc00\ud800', '\udc00'],
    ['e\u0301', 'e'],
    ['👩‍💻', '👩‍'],
    ['\r\n', '\r']
  ])('preserves code-point deletion for %j', (fieldText, expected) => {
    expect(getTerminalLiveAccessoryLocalEditText({ localEdit: 'backspace', fieldText })).toBe(
      expected
    )
    expect(getTerminalLiveAccessoryLocalEditText({ localEdit: 'delete', fieldText })).toBe(
      fieldText
    )
  })
})
