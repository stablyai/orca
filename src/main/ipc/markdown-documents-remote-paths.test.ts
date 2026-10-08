import { describe, expect, it, vi } from 'vitest'
import type * as NodePath from 'node:path'

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual, extname: actual.win32.extname }
})

import { isMarkdownDocumentName, markdownDocumentFromRelativePath } from './markdown-documents'

describe('remote Markdown filenames on a Windows client', () => {
  it('keeps the local filename helper on Windows semantics', () => {
    expect(isMarkdownDocumentName('notes\\.md')).toBe(false)
    expect(isMarkdownDocumentName('notes.md\\')).toBe(true)
  })

  it.each(['notes\\.md', 'a\\b.MDX', '..\\a.markdown', 'nested/README.md'])(
    'preserves POSIX filename %s and its extension',
    (relativePath) => {
      const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1)
      expect(markdownDocumentFromRelativePath('/home/repo', relativePath)).toEqual({
        filePath: `/home/repo/${relativePath}`,
        relativePath,
        basename,
        name: basename.slice(0, basename.lastIndexOf('.'))
      })
    }
  )

  it.each(['notes.md\\', 'nested/.md', '../outside.md'])(
    'rejects non-Markdown or escaping POSIX filename %s',
    (relativePath) => {
      expect(markdownDocumentFromRelativePath('/home/repo', relativePath)).toBeNull()
    }
  )

  it('normalizes Windows remote separators before reading the basename', () => {
    expect(markdownDocumentFromRelativePath('C:\\repo', 'notes\\README.MD')).toEqual({
      filePath: 'C:\\repo/notes/README.MD',
      relativePath: 'notes/README.MD',
      basename: 'README.MD',
      name: 'README'
    })
    expect(markdownDocumentFromRelativePath('C:\\repo', 'notes\\.md')).toBeNull()
    expect(markdownDocumentFromRelativePath('C:\\repo', '..\\outside.md')).toBeNull()
  })
})
