import { createElement, type ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileSessionMarkdownPreview } from './MobileSessionMarkdownPreview'

vi.mock('react-native', () => ({ ScrollView: 'ScrollView' }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../files/mobile-file-preview-styles', () => ({
  filePreviewStyles: { scroll: {}, markdownContent: {} }
}))
vi.mock('../files/MobileFilePreviewSourceText', () => ({
  MobileFilePreviewTruncatedNote: 'MobileFilePreviewTruncatedNote'
}))
vi.mock('../files/MobileMarkdownPreviewImage', () => ({
  MobileMarkdownPreviewImage: 'MobileMarkdownPreviewImage'
}))
vi.mock('../components/MobileMarkdown', () => ({
  MobileMarkdown: ({ renderImage }: { renderImage?: (href: string, alt: string) => ReactNode }) =>
    renderImage?.('images/diagram.png', 'Diagram') ?? null
}))

describe('MobileSessionMarkdownPreview', () => {
  it('forwards documentAbsolutePath and relativePath to MobileMarkdownPreviewImage', () => {
    let renderer: ReturnType<typeof create> | undefined
    act(() => {
      renderer = create(
        createElement(MobileSessionMarkdownPreview, {
          relativePath: 'docs/notes.md',
          documentAbsolutePath: '/workspace/docs/notes.md',
          content: '![Diagram](images/diagram.png)',
          truncated: false,
          byteLength: 30,
          worktreeId: 'folder:project',
          client: null
        })
      )
    })
    const image = renderer!.root.findByType('MobileMarkdownPreviewImage')
    expect(image.props).toMatchObject({
      worktreeId: 'folder:project',
      documentPath: 'docs/notes.md',
      documentAbsolutePath: '/workspace/docs/notes.md',
      href: 'images/diagram.png',
      alt: 'Diagram'
    })
    act(() => renderer?.unmount())
  })
})
