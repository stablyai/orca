import { describe, expect, it } from 'vitest'
import {
  markdownDocumentFromFilePath,
  markdownDocumentFromRelativePath
} from './markdown-documents'

describe('markdownDocumentFromFilePath', () => {
  it.skipIf(process.platform === 'win32')('preserves local literal backslash names', () => {
    expect(markdownDocumentFromFilePath('/repo\\', '/repo\\/a\\b.md')).toMatchObject({
      filePath: '/repo\\/a\\b.md',
      relativePath: 'a\\b.md',
      basename: 'a\\b.md'
    })
  })

  it('preserves POSIX remote filenames and trailing root backslashes', () => {
    for (const name of ['a\\b.md', 'a/b.md', '..\\a.md']) {
      expect(markdownDocumentFromRelativePath('/repo\\', name)).toMatchObject({
        filePath: `/repo\\/${name}`,
        relativePath: name,
        basename: name.slice(name.lastIndexOf('/') + 1)
      })
    }
    expect(markdownDocumentFromRelativePath('/repo\\', '../a.md')).toBeNull()
  })

  it.each(['C:\\repo\\', '\\\\server\\share\\repo\\'])(
    'preserves Windows separator handling under %s',
    (root) => {
      expect(markdownDocumentFromRelativePath(root, 'a\\b.md')).toMatchObject({
        filePath: `${root.slice(0, -1)}/a/b.md`,
        relativePath: 'a/b.md',
        basename: 'b.md'
      })
      expect(markdownDocumentFromRelativePath(root, '..\\a.md')).toBeNull()
    }
  )

  it('keeps in-root path segments that merely start with parent traversal text', () => {
    expect(markdownDocumentFromFilePath('/workspace', '/workspace/..notes/file.md')).toMatchObject({
      filePath: '/workspace/..notes/file.md',
      relativePath: '..notes/file.md',
      basename: 'file.md',
      name: 'file'
    })
  })

  it('treats actual parent traversal as outside the root', () => {
    expect(
      markdownDocumentFromFilePath('/workspace', '/workspace-other/file.md', {
        outsideRootRelativePath: 'basename'
      })
    ).toMatchObject({
      filePath: '/workspace-other/file.md',
      relativePath: 'file.md',
      basename: 'file.md',
      name: 'file'
    })
  })
})
