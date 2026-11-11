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
  it('keeps the accessory Del local-edit rule for a bare forward delete only', () => {
    expect(chord('delete')).toEqual({ bytes: '\x1b[3~', localEdit: 'delete' })
    expect(chord('delete', { ctrl: true })).toEqual({ bytes: '\x1b[3;5~' })
  })
})
