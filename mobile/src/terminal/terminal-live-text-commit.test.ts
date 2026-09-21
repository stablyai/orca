import { describe, expect, it, vi } from 'vitest'
import {
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText,
  getTerminalLiveSpecialKeyDecision
} from './terminal-live-text-commit'

describe('terminal live special key decision', () => {
  it('Given an unmapped key Then ignores it', () => {
    expect(getTerminalLiveSpecialKeyDecision({ key: 'ㅎ', heldText: '', sentText: '' })).toEqual({
      kind: 'ignore'
    })
  })

  it('Given Backspace with any field text Then edits locally so the mirror diff handles the PTY erase', () => {
    // Held syllable present
    expect(
      getTerminalLiveSpecialKeyDecision({ key: 'Backspace', heldText: '한', sentText: '' })
    ).toEqual({ kind: 'local-edit' })
    // Only mirrored text present — native edit fires onChangeText and the diff erases
    expect(
      getTerminalLiveSpecialKeyDecision({ key: 'Backspace', heldText: '', sentText: 'abc' })
    ).toEqual({ kind: 'local-edit' })
  })

  it('Given Backspace with an empty field Then sends terminal backspace bytes', () => {
    const decision = getTerminalLiveSpecialKeyDecision({
      key: 'Backspace',
      heldText: '',
      sentText: ''
    })
    expect(decision.kind).toBe('send-now')
  })

  it('Given a control key with a held syllable Then commits the held text before the bytes', () => {
    const decision = getTerminalLiveSpecialKeyDecision({
      key: 'Tab',
      heldText: '글',
      sentText: '한'
    })
    expect(decision.kind).toBe('commit-held-then-send')
  })

  it('Given a control key with no held syllable Then sends immediately', () => {
    const decision = getTerminalLiveSpecialKeyDecision({
      key: 'ArrowUp',
      heldText: '',
      sentText: 'ls'
    })
    expect(decision.kind).toBe('send-now')
  })
})

describe('terminal live accessory bytes decision', () => {
  it('Given a local-edit accessory key with field text Then edits locally', () => {
    expect(
      getTerminalLiveAccessoryBytesDecision({
        bytes: '\x7f',
        localEdit: 'backspace',
        heldText: '한',
        sentText: ''
      })
    ).toEqual({ kind: 'local-edit', localEdit: 'backspace' })
    expect(
      getTerminalLiveAccessoryBytesDecision({
        bytes: '\x7f',
        localEdit: 'backspace',
        heldText: '',
        sentText: 'abc'
      })
    ).toEqual({ kind: 'local-edit', localEdit: 'backspace' })
  })

  it('Given raw accessory bytes with a held syllable Then commits held text first', () => {
    const decision = getTerminalLiveAccessoryBytesDecision({
      bytes: '\x1b',
      heldText: '한',
      sentText: ''
    })
    expect(decision).toEqual({ kind: 'commit-held-then-send', bytes: '\x1b' })
  })

  it('Given raw accessory bytes with nothing held Then sends immediately', () => {
    const decision = getTerminalLiveAccessoryBytesDecision({
      bytes: '\x1b',
      heldText: '',
      sentText: 'abc'
    })
    expect(decision).toEqual({ kind: 'send-now', bytes: '\x1b' })
  })

  it('Given a local-edit accessory key with an empty field Then sends the raw bytes', () => {
    const decision = getTerminalLiveAccessoryBytesDecision({
      bytes: '\x7f',
      localEdit: 'backspace',
      heldText: '',
      sentText: ''
    })
    expect(decision).toEqual({ kind: 'send-now', bytes: '\x7f' })
  })
})

describe('terminal live accessory local edit text', () => {
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

  it('does not iterate the input prefix to delete the final code point', () => {
    const fieldText = `${'a'.repeat(100_000)}🙂`
    const originalIterator = String.prototype[Symbol.iterator]
    let visits = 0
    const iterator = vi
      .spyOn(String.prototype, Symbol.iterator)
      .mockImplementation(function* (this: string) {
        for (const codePoint of originalIterator.call(this)) {
          visits += 1
          yield codePoint
        }
      })
    let result: string
    try {
      result = getTerminalLiveAccessoryLocalEditText({ localEdit: 'backspace', fieldText })
    } finally {
      iterator.mockRestore()
    }
    expect(result).toBe('a'.repeat(100_000))
    expect(visits).toBeLessThanOrEqual(2)
  })

  it('Given backspace Then drops the last code point of the field text', () => {
    expect(
      getTerminalLiveAccessoryLocalEditText({ localEdit: 'backspace', fieldText: '한글' })
    ).toBe('한')
    expect(getTerminalLiveAccessoryLocalEditText({ localEdit: 'backspace', fieldText: '한' })).toBe(
      ''
    )
  })

  it('Given forward delete Then keeps the field text unchanged', () => {
    expect(getTerminalLiveAccessoryLocalEditText({ localEdit: 'delete', fieldText: '한글' })).toBe(
      '한글'
    )
  })
})
