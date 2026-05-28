import { describe, expect, it } from 'vitest'
import { markdownDocumentFromFilePath } from './markdown-documents'

describe('markdownDocumentFromFilePath', () => {
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
