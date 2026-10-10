import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownReader } from './MobileSessionMarkdownReader'
import type { MarkdownDocState } from './mobile-session-route-types'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator'
}))
vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))
vi.mock('../components/MobileRichMarkdownEditor', () => ({
  MobileRichMarkdownEditor: 'MobileRichMarkdownEditor'
}))
vi.mock('./mobile-session-styles', () => ({ styles: {} }))

const doc: MarkdownDocState = {
  status: 'ready',
  content: '# Saved',
  localContent: '# Saved',
  baseVersion: '1',
  isDirty: false,
  editable: true
}

describe('live session markdown reader copy', () => {
  let renderer: ReactTestRenderer | undefined
  const onCopy = vi.fn(),
    onSave = vi.fn(),
    onDiscard = vi.fn(),
    onRefresh = vi.fn()
  function render(value: MarkdownDocState | undefined = doc) {
    act(() => {
      renderer = create(
        createElement(MarkdownReader, {
          documentId: 'doc',
          doc: value,
          onCopy,
          onSave,
          onDiscard,
          onRefresh,
          onChange: vi.fn(),
          keyboardLift: 0
        })
      )
    })
  }
  const buttons = () => renderer!.root.findAll((node) => String(node.type) === 'Pressable')
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => act(() => renderer?.unmount()))

  it.each([
    ['editable', {}],
    ['dirty', { isDirty: true, localContent: '# Unsaved' }],
    ['read-only', { editable: false }],
    ['saving', { isDirty: true, saving: true }]
  ] as const)(
    'offers Copy on a ready %s document without saving or discarding',
    (_name, fields) => {
      render({ ...doc, ...fields })
      const copy = buttons().find(
        (node) => node.props.accessibilityLabel === 'Copy Markdown source'
      )
      expect(copy).toBeDefined()
      expect(copy?.props.accessibilityRole).toBe('button')
      expect(copy?.props.disabled).not.toBe(true)
      act(() => copy?.props.onPress())
      expect(onCopy).toHaveBeenCalledOnce()
      expect(onSave).not.toHaveBeenCalled()
      expect(onDiscard).not.toHaveBeenCalled()
    }
  )

  it('keeps loading and error states free of copy actions', () => {
    render({ status: 'loading' })
    expect(buttons()).toHaveLength(0)
    act(() =>
      renderer!.update(
        createElement(MarkdownReader, {
          documentId: 'doc',
          doc: { status: 'error', message: 'Unavailable' },
          onCopy,
          onSave,
          onDiscard,
          onRefresh,
          onChange: vi.fn(),
          keyboardLift: 0
        })
      )
    )
    expect(buttons()).toHaveLength(1)
    act(() => buttons()[0]!.props.onPress())
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onCopy).not.toHaveBeenCalled()
  })
})
