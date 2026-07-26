import { describe, expect, it } from 'vitest'
import {
  markdownDocumentFromFilePath,
  markdownDocumentsFromRelativePaths
} from './markdown-documents'
import { MarkdownDocumentListingCapacityError } from '../../shared/markdown-document-listing-limits'

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

describe('markdownDocumentsFromRelativePaths', () => {
  it('preserves filtering and sorted output below every limit', () => {
    expect(
      markdownDocumentsFromRelativePaths('/workspace', [
        'z-last.markdown',
        'src/app.ts',
        '../outside.md',
        'docs/Guide.MDX',
        'README.md'
      ])
    ).toEqual([
      {
        filePath: '/workspace/docs/Guide.MDX',
        relativePath: 'docs/Guide.MDX',
        basename: 'Guide.MDX',
        name: 'Guide'
      },
      {
        filePath: '/workspace/README.md',
        relativePath: 'README.md',
        basename: 'README.md',
        name: 'README'
      },
      {
        filePath: '/workspace/z-last.markdown',
        relativePath: 'z-last.markdown',
        basename: 'z-last.markdown',
        name: 'z-last'
      }
    ])
  })

  it('rejects count, metadata, and UTF-8 path overflow before retaining another result', () => {
    expect(() =>
      markdownDocumentsFromRelativePaths('/workspace', ['one.md', 'two.md'], {
        maxDocuments: 1
      })
    ).toThrow(MarkdownDocumentListingCapacityError)
    expect(() =>
      markdownDocumentsFromRelativePaths('/workspace', ['metadata.md'], {
        maxMetadataBytes: 1
      })
    ).toThrow(MarkdownDocumentListingCapacityError)
    expect(() =>
      markdownDocumentsFromRelativePaths('/workspace', [`${'é'.repeat(40_000)}.md`])
    ).toThrow(MarkdownDocumentListingCapacityError)
  })
})
