import { describe, expect, it } from 'vitest'
import { macKeyEditingCommands } from './offscreen-page-mac-key-commands'

describe('macKeyEditingCommands', () => {
  it('gives text navigation keys their Cocoa commands', () => {
    expect(macKeyEditingCommands('ArrowLeft', [])).toEqual(['moveLeft'])
    expect(macKeyEditingCommands('Backspace', ['alt'])).toEqual(['deleteWordBackward'])
    expect(macKeyEditingCommands('KeyE', ['control'])).toEqual(['moveToEndOfParagraph'])
  })

  it('matches modifiers in any order', () => {
    expect(macKeyEditingCommands('KeyZ', ['meta', 'shift'])).toEqual(['redo'])
    expect(macKeyEditingCommands('KeyC', ['meta'])).toEqual(['copy'])
  })

  it('drops text insertion and unknown chords', () => {
    expect(macKeyEditingCommands('Enter', [])).toEqual([])
    expect(macKeyEditingCommands('KeyQ', ['meta'])).toEqual([])
  })
})
