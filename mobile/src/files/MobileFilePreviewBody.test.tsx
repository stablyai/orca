import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileFilePreviewBody } from './MobileFilePreviewBody'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/MobileSvgPreview', () => ({ MobileSvgPreview: 'SvgPreview' }))
vi.mock('../components/MobilePanZoomImage', () => ({ MobilePanZoomImage: 'PanZoomImage' }))
vi.mock('../components/MobileStateView', () => ({
  MobileLoadErrorState: 'LoadError',
  MobileOfflineState: 'Offline',
  MobileStateView: 'StateView'
}))
vi.mock('./MobileFileMediaPreview', () => ({ MobileFileMediaPreview: 'Media' }))
vi.mock('./MobileFileMarkdownPreview', () => ({ MobileFileMarkdownPreview: 'Markdown' }))
vi.mock('./MobileFilePreviewEditableSource', () => ({
  MobileFilePreviewEditableSource: 'EditableSource'
}))
vi.mock('./MobileFilePreviewSourceText', () => ({ MobileFilePreviewSourceText: 'SourceText' }))

let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

it('previews a writable SVG draft and keeps its save failure visible outside Source', () => {
  act(() => {
    tree = create(
      createElement(MobileFilePreviewBody, {
        preview: {
          status: 'ready',
          kind: 'svg',
          content: '<svg>saved</svg>',
          truncated: false,
          byteLength: 16
        },
        relativePath: '/tmp/diagram.svg',
        title: 'diagram.svg',
        editable: true,
        markdownMode: 'preview',
        draftContent: '<svg>draft</svg>',
        saveError: 'Could not save',
        lineColumn: null,
        onDraftChange: () => {},
        onImageError: () => {},
        onRetry: null
      })
    )
  })
  const svg = tree!.root.find((node) => String(node.type) === 'SvgPreview')
  expect(svg.props.markup).toBe('<svg>draft</svg>')
  let notice: ReactTestRenderer | null = null
  let source: ReactTestRenderer | null = null
  act(() => {
    notice = create(svg.props.notice)
    source = create(svg.props.renderSource())
  })
  expect(notice!.root.find((node) => String(node.type) === 'Text').props.children).toBe(
    'Could not save'
  )
  expect(source!.root.findAll((node) => String(node.type) === 'EditableSource')).toHaveLength(1)
})
