import { describe, expect, it } from 'vitest'
import type { TerminalDocumentBuffer, TerminalDocumentLine } from './document-terminal-shape'
import { extractActivePromptInputBeforeCursor } from './prompt-line-backload'

function makeMockBuffer(options: {
  rows: Array<{ text: string; isWrapped?: boolean }>
  cursorY: number
  cursorX: number
  baseY?: number
  type?: string
}): TerminalDocumentBuffer {
  const { rows, cursorY, cursorX, baseY = 0, type = 'normal' } = options
  return {
    length: rows.length,
    viewportY: baseY,
    baseY,
    cursorX,
    cursorY,
    type,
    getLine(index: number): TerminalDocumentLine | undefined {
      const entry = rows[index]
      if (!entry) {
        return undefined
      }
      return {
        length: 80,
        isWrapped: entry.isWrapped === true,
        translateToString: (_trimRight: boolean, start = 0, end = entry.text.length) =>
          entry.text.slice(start, end)
      }
    }
  }
}

describe('extractActivePromptInputBeforeCursor', () => {
  it('extracts text before cursor for agent TUI prompts and ignores text after cursor', () => {
    const line = '❯ fix mobile backload   placeholder after cursor'
    const cursorX = '❯ fix mobile backload'.length
    const buffer = makeMockBuffer({
      rows: [{ text: line }],
      cursorY: 0,
      cursorX
    })
    expect(extractActivePromptInputBeforeCursor(buffer)).toBe('fix mobile backload')
  })

  it('preserves user-typed trailing spaces before the cursor', () => {
    const typed = '❯ continue typing '
    const buffer = makeMockBuffer({
      rows: [{ text: typed + '      ' }],
      cursorY: 0,
      cursorX: typed.length
    })
    expect(extractActivePromptInputBeforeCursor(buffer)).toBe('continue typing ')
  })

  it('returns empty string when prompt has no user input yet', () => {
    const buffer = makeMockBuffer({
      rows: [{ text: '❯       ' }],
      cursorY: 0,
      cursorX: 2
    })
    expect(extractActivePromptInputBeforeCursor(buffer)).toBe('')
  })

  it('extracts boxed TUI prompts and POSIX user@host prompts', () => {
    const boxed = '│ > add inline comment'
    expect(
      extractActivePromptInputBeforeCursor(
        makeMockBuffer({ rows: [{ text: boxed }], cursorY: 0, cursorX: boxed.length })
      )
    ).toBe('add inline comment')

    const posix = 'aleksei@HP:~/Projects/w0m$ git status -sb'
    expect(
      extractActivePromptInputBeforeCursor(
        makeMockBuffer({ rows: [{ text: posix }], cursorY: 0, cursorX: posix.length })
      )
    ).toBe('git status -sb')
  })

  it('reconstructs soft-wrapped multi-row prompts up to cursorX', () => {
    const row0 = '❯ write a unit test that verifies soft-wrapped prompt backloading '
    const row1 = 'across multiple terminal rows'
    const buffer = makeMockBuffer({
      rows: [
        { text: row0, isWrapped: false },
        { text: row1, isWrapped: true }
      ],
      cursorY: 1,
      cursorX: row1.length
    })
    expect(extractActivePromptInputBeforeCursor(buffer)).toBe(
      'write a unit test that verifies soft-wrapped prompt backloading across multiple terminal rows'
    )
  })

  it('never backloads non-prompt program output or alternate-screen buffers', () => {
    const output = 'Building target... 50% complete ($ 5)'
    expect(
      extractActivePromptInputBeforeCursor(
        makeMockBuffer({ rows: [{ text: output }], cursorY: 0, cursorX: output.length })
      )
    ).toBe('')

    const altPrompt = '❯ inside fullscreen app'
    expect(
      extractActivePromptInputBeforeCursor(
        makeMockBuffer({
          rows: [{ text: altPrompt }],
          cursorY: 0,
          cursorX: altPrompt.length,
          type: 'alternate'
        })
      )
    ).toBe('')
  })
})
