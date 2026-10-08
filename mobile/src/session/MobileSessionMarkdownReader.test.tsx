import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownReader } from './MobileSessionMarkdownReader'
import type { MarkdownDocState } from './mobile-session-route-types'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))

// Records what the WebView editor would receive; the bridge itself is covered elsewhere.
const editorProps: Array<Record<string, unknown>> = []
vi.mock('../components/MobileRichMarkdownEditor', () => ({
  MobileRichMarkdownEditor: (props: Record<string, unknown>) => {
    editorProps.push(props)
    return null
  }
}))

const readyDoc: MarkdownDocState = {
  status: 'ready',
  content: '# Notes',
  localContent: '# Notes',
  baseVersion: '1',
  isDirty: false,
  editable: true
}

describe('MarkdownReader', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    editorProps.length = 0
  })

  function render(doc: MarkdownDocState, onOpenImage: (rawSrc: string) => void): void {
    act(() => {
      renderer = create(
        createElement(MarkdownReader, {
          documentId: 'doc-1',
          doc,
          onRefresh: vi.fn(),
          onChange: vi.fn(),
          onSave: vi.fn(),
          onCopy: vi.fn(),
          onDiscard: vi.fn(),
          onOpenImage,
          keyboardLift: 0
        })
      )
    })
  }

  it('forwards the doc image sources to the editor', () => {
    const imageSources = { 'images/shot.png': 'data:image/png;base64,AAA' }
    render({ ...readyDoc, imageSources }, vi.fn())
    expect(editorProps.at(-1)?.imageSources).toBe(imageSources)
  })

  it('forwards the image-tap handler to the editor', () => {
    const onOpenImage = vi.fn()
    render(readyDoc, onOpenImage)
    expect(editorProps.at(-1)?.onOpenImage).toBe(onOpenImage)
  })
})
