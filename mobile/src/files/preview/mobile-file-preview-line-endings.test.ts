import { describe, expect, it } from 'vitest'
import { editorTextOfFileText, fileTextOfEditorText } from './mobile-file-preview-line-endings'

describe('file preview line endings', () => {
  it('keeps each file its own ending through a textarea edit', () => {
    const crlf = 'a\r\nb\r\n'
    const lf = 'a\nb\n'
    // The textarea hands back LF only, whatever the file held.
    expect(editorTextOfFileText(crlf)).toBe(lf)
    expect(fileTextOfEditorText(`${lf}c\n`, crlf)).toBe('a\r\nb\r\nc\r\n')
    expect(fileTextOfEditorText(`${lf}c\n`, lf)).toBe('a\nb\nc\n')
    // A mixed file takes its dominant ending, as the desktop editor does.
    expect(fileTextOfEditorText('x\ny\nz', 'p\r\nq\r\nr\ns')).toBe('x\r\ny\r\nz')
    expect(fileTextOfEditorText('x\ny', 'p\nq\nr\r\ns')).toBe('x\ny')
    // A classic-Mac file keeps its lone CR endings.
    expect(editorTextOfFileText('a\rb\r')).toBe('a\nb\n')
    expect(fileTextOfEditorText('a\nb\nc\n', 'a\rb\r')).toBe('a\rb\rc\r')
  })
})
