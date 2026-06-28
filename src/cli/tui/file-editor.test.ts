import { describe, expect, it } from 'vitest'
import { FileEditor } from './file-editor'
import type { LogicalKey } from './tty-key-adapter'

const char = (value: string): LogicalKey => ({ type: 'char', value })

function loaded(content: string): FileEditor {
  const editor = new FileEditor()
  editor.load(content)
  return editor
}

describe('FileEditor', () => {
  it('inserts characters at the cursor and tracks dirtiness', () => {
    const editor = loaded('ab')
    expect(editor.dirty).toBe(false)
    editor.handleKey(char('X'))
    expect(editor.content).toBe('Xab')
    expect(editor.dirty).toBe(true)
  })

  it('splits and joins lines with Enter and Backspace', () => {
    const editor = loaded('ab')
    editor.handleKey(char('a')) // cursor now after first inserted char
    editor.setCursor(0, 1)
    editor.handleKey({ type: 'enter' })
    expect(editor.content).toBe('a\nab')
    editor.handleKey({ type: 'backspace' })
    expect(editor.content).toBe('aab')
  })

  it('moves the cursor across line boundaries', () => {
    const editor = loaded('ab\ncd')
    editor.setCursor(0, 2)
    editor.handleKey({ type: 'right' }) // wraps to start of next line
    editor.handleKey(char('!'))
    expect(editor.content).toBe('ab\n!cd')
  })

  it('markSaved clears dirty; revert restores the baseline', () => {
    const editor = loaded('hi')
    editor.handleKey(char('!'))
    editor.markSaved()
    expect(editor.dirty).toBe(false)
    editor.handleKey(char('?'))
    editor.revert()
    expect(editor.content).toBe('!hi')
    expect(editor.dirty).toBe(false)
  })

  it('maps a click cell-column to the buffer index across wide glyphs', () => {
    const editor = loaded('日本x') // each CJK char is 2 cells wide
    // Click at visible column 4 → past the two 2-cell glyphs → buffer index 2.
    editor.setCursorFromClick(0, 4)
    editor.handleKey(char('!'))
    expect(editor.content).toBe('日本!x')
  })

  it('draws the cursor cell inverse in the rendered lines', () => {
    const editor = loaded('ab')
    editor.setCursor(0, 0)
    expect(editor.renderLines()[0]).toContain('\x1b[7m')
  })

  it('ignores non-editing keys', () => {
    const editor = loaded('x')
    expect(editor.handleKey({ type: 'escape' })).toBe(false)
  })
})
