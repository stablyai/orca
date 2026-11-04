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
    expect(
      getTerminalLiveSpecialKeyDecision({ key: 'Backspace', heldText: '한', sentText: '' })
    ).toEqual({ kind: 'local-edit' })
    expect(
      getTerminalLiveSpecialKeyDecision({ key: 'Backspace', heldText: '', sentText: 'abc' })
    ).toEqual({ kind: 'local-edit' })
  })

  it.each(['ArrowLeft', 'ArrowRight', 'Home', 'End'])(
    'Given %s with field text Then moves only the field caret, keeping the PTY cursor at the mirror end',
    (key) => {
      expect(
        getTerminalLiveSpecialKeyDecision({
          key,
          heldText: '',
          sentText: 'abc',
          caretAtFieldEnd: false
        })
      ).toEqual({ kind: 'local-edit' })
      expect(getTerminalLiveSpecialKeyDecision({ key, heldText: '', sentText: '' }).kind).toBe(
        'send-now'
      )
    }
  )

  it.each(['ArrowRight', 'End'])(
    'Given %s with the caret at the field end Then sends it so shells can accept an autosuggestion',
    (key) => {
      expect(
        getTerminalLiveSpecialKeyDecision({ key, heldText: '', sentText: 'git ch' }).kind
      ).toBe('send-now')
    }
  )

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

  it('does not iterate the input prefix to delete the final code point', () => {
    const fieldText = `${'a'.repeat(100_000)}🙂`
    const originalIterator = String.prototype[Symbol.iterator]
    let visits = 0
    const iterator = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function* (
      this: string
    ): Generator<string, undefined> {
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
