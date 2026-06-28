import { describe, expect, it } from 'vitest'
import { decodeKey, isMouseSequence } from './tty-key-adapter'

describe('decodeKey', () => {
  it('decodes arrow keys (CSI and SS3 forms)', () => {
    expect(decodeKey('\x1b[A')).toEqual({ type: 'up' })
    expect(decodeKey('\x1b[B')).toEqual({ type: 'down' })
    expect(decodeKey('\x1bOC')).toEqual({ type: 'right' })
    expect(decodeKey('\x1bOD')).toEqual({ type: 'left' })
  })

  it('decodes Enter, Tab, Esc, and Backspace', () => {
    expect(decodeKey('\r')).toEqual({ type: 'enter' })
    expect(decodeKey('\n')).toEqual({ type: 'enter' })
    expect(decodeKey('\t')).toEqual({ type: 'tab' })
    expect(decodeKey('\x1b')).toEqual({ type: 'escape' })
    expect(decodeKey('\x7f')).toEqual({ type: 'backspace' })
  })

  it('decodes Ctrl+letter from control codes', () => {
    expect(decodeKey('\x03')).toEqual({ type: 'ctrl', value: 'c' })
    expect(decodeKey('\x02')).toEqual({ type: 'ctrl', value: 'b' })
    expect(decodeKey('\x12')).toEqual({ type: 'ctrl', value: 'r' })
  })

  it('decodes printable characters', () => {
    expect(decodeKey('q')).toEqual({ type: 'char', value: 'q' })
    expect(decodeKey('?')).toEqual({ type: 'char', value: '?' })
  })

  it('returns null for a mouse report rather than misreading it as a key', () => {
    expect(decodeKey('\x1b[<0;10;5M')).toBeNull()
    expect(isMouseSequence('\x1b[<0;10;5M')).toBe(true)
    expect(isMouseSequence('q')).toBe(false)
  })

  it('returns null for empty input', () => {
    expect(decodeKey('')).toBeNull()
  })
})
