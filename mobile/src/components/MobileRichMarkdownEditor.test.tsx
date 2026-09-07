import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MobileRichMarkdownEditor,
  type MobileRichMarkdownEditorHandle
} from './MobileRichMarkdownEditor'

const mocks = vi.hoisted(() => ({
  dismissKeyboard: vi.fn(),
  injectJavaScript: vi.fn()
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Keyboard: { dismiss: mocks.dismissKeyboard },
    Linking: { openURL: vi.fn() },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    View: 'View'
  }
})

vi.mock('react-native-webview', () => {
  const WebView = forwardRef((props: Record<string, unknown>, ref) => {
    useImperativeHandle(ref, () => ({ injectJavaScript: mocks.injectJavaScript }))
    return createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('lucide-react-native', () => ({
  Bold: 'Bold',
  ChevronDown: 'ChevronDown',
  Code2: 'Code2',
  FileCode2: 'FileCode2',
  Heading1: 'Heading1',
  Heading2: 'Heading2',
  Heading3: 'Heading3',
  ImageIcon: 'ImageIcon',
  Italic: 'Italic',
  Keyboard: 'Keyboard',
  Link: 'Link',
  List: 'List',
  ListOrdered: 'ListOrdered',
  ListTodo: 'ListTodo',
  Pilcrow: 'Pilcrow',
  Quote: 'Quote',
  Strikethrough: 'Strikethrough'
}))

describe('MobileRichMarkdownEditor', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  it('exposes WebView keyboard dismissal to its native parent', () => {
    const editorRef = createRef<MobileRichMarkdownEditorHandle>()
    act(() => {
      renderer = create(
        createElement(MobileRichMarkdownEditor, {
          ref: editorRef,
          content: '',
          editable: true,
          onChange: vi.fn()
        })
      )
    })

    act(() => editorRef.current?.dismissKeyboard())

    expect(mocks.injectJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('window.__orcaRichMarkdown.dismissKeyboard()')
    )
    expect(mocks.dismissKeyboard).toHaveBeenCalledOnce()
  })
})
