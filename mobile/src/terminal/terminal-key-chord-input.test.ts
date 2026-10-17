import { describe, expect, it } from 'vitest'
import { createTerminalKeyChordInput } from './terminal-key-chord-input'

const chord = (key: string, modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  createTerminalKeyChordInput({
    key,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false
  })

describe('createTerminalKeyChordInput', () => {
  it('encodes keyboard chords as the bytes a terminal expects', () => {
    expect(chord('c', { ctrl: true })).toEqual({ bytes: '\x03' })
    expect(chord('[', { ctrl: true })).toEqual({ bytes: '\x1b' })
    expect(chord('space', { ctrl: true })).toEqual({ bytes: '\x00' })
    expect(chord('b', { alt: true })).toEqual({ bytes: '\x1bb' })
    expect(chord('B', { alt: true })).toEqual({ bytes: '\x1bB' })
    expect(chord('C', { ctrl: true })).toEqual({ bytes: '\x03' })
    expect(chord('/', { ctrl: true })).toEqual({ bytes: '\x1f' })
    expect(chord('enter', { alt: true })).toEqual({ bytes: '\x1b\r' })
    expect(chord('tab', { shift: true })).toEqual({ bytes: '\x1b[Z' })
    expect(chord('arrowUp', { ctrl: true })).toEqual({ bytes: '\x1b[1;5A' })
    expect(chord('escape')).toEqual({ bytes: '\x1b' })
  })

  it('keeps the accessory Del local-edit rule for a bare forward delete only', () => {
    expect(chord('delete')).toEqual({ bytes: '\x1b[3~', localEdit: 'delete' })
    expect(chord('delete', { ctrl: true })).toEqual({ bytes: '\x1b[3;5~' })
  })

  it('drops chords with no terminal encoding', () => {
    expect(chord('1', { ctrl: true })).toBeNull()
  })
})
