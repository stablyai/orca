import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownReader } from './MobileSessionMarkdownReader'
import { clearMobileMarkdownViewModeState } from './mobile-markdown-view-mode-state'
import { MobileFilePreviewSourceText } from '../files/MobileFilePreviewSourceText'
import type { MarkdownDocState } from './mobile-session-route-types'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  RefreshCw: 'RefreshCw',
  ListOrdered: 'ListOrdered',
  Copy: 'Copy',
  Check: 'Check'
}))
vi.mock('../components/MobileRichMarkdownEditor', () => ({
  MobileRichMarkdownEditor: 'MobileRichMarkdownEditor'
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
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
    onCopyPath = vi.fn(),
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
          onCopyPath,
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
  beforeEach(() => {
    vi.clearAllMocks()
    clearMobileMarkdownViewModeState()
  })
  afterEach(() => act(() => renderer?.unmount()))

  it.each([
    ['editable', {}],
    ['dirty', { isDirty: true, localContent: '# Unsaved' }],
    ['read-only', { editable: false }],
    ['saving', { isDirty: true, saving: true }],
    ['truncated', { truncated: true }]
  ] as const)(
    'offers adjacent source and path copy actions on a ready %s document',
    (_name, fields) => {
      render({ ...doc, ...fields })
      const copy = buttons().find(
        (node) =>
          node.props.accessibilityLabel ===
          ('truncated' in fields ? 'Copy loaded Markdown source' : 'Copy Markdown source')
      )
      expect(copy).toBeDefined()
      expect(buttons()[0]).toBe(copy)
      expect(copy?.props.accessibilityRole).toBe('button')
      expect(copy?.props.disabled).not.toBe(true)
      act(() => copy?.props.onPress())
      expect(onCopy).toHaveBeenCalledOnce()
      const pathCopy = buttons()[1]!
      expect(pathCopy.props.accessibilityLabel).toBe('Copy Markdown path')
      expect(pathCopy.props.accessibilityRole).toBe('button')
      expect(pathCopy.props.disabled).not.toBe(true)
      act(() => pathCopy.props.onPress())
      expect(onCopyPath).toHaveBeenCalledOnce()
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
          onCopyPath,
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
    expect(onCopyPath).not.toHaveBeenCalled()
  })

  it('toggles between rich editor and source view with line numbers', () => {
    render(doc)
    const viewToggle = buttons().find(
      (node) => node.props.accessibilityLabel === 'View Markdown source'
    )
    expect(viewToggle).toBeDefined()
    expect(
      buttons().find(
        (node) =>
          node.props.accessibilityLabel === 'Show line numbers' ||
          node.props.accessibilityLabel === 'Hide line numbers'
      )
    ).toBeUndefined()

    act(() => viewToggle!.props.onPress())

    const lineToggle = buttons().find(
      (node) =>
        node.props.accessibilityLabel === 'Show line numbers' ||
        node.props.accessibilityLabel === 'Hide line numbers'
    )
    expect(lineToggle).toBeDefined()

    const richToggle = buttons().find(
      (node) => node.props.accessibilityLabel === 'View rich editor'
    )
    expect(richToggle).toBeDefined()
    act(() => {
      richToggle!.props.onPress()
    })

    expect(
      buttons().find(
        (node) => node.props.accessibilityLabel === 'View Markdown source'
      )
    ).toBeDefined()
  })

  it('renders top address bar with line number toggle, path, and copy in source view', () => {
    act(() => {
      renderer = create(
        createElement(MarkdownReader, {
          documentId: 'doc',
          doc,
          title: 'README.md',
          relativePath: 'docs/README.md',
          onCopy,
          onCopyPath,
          onSave,
          onDiscard,
          onRefresh,
          onChange: vi.fn(),
          keyboardLift: 0
        })
      )
    })
    const viewToggle = buttons().find(
      (node) => node.props.accessibilityLabel === 'View Markdown source'
    )
    act(() => viewToggle!.props.onPress())

    const sourceCopy = buttons().find(
      (node) => node.props.accessibilityLabel === 'Copy file content'
    )
    expect(sourceCopy).toBeDefined()

    const lineToggle = buttons().find(
      (node) =>
        node.props.accessibilityLabel === 'Show line numbers' ||
        node.props.accessibilityLabel === 'Hide line numbers'
    )
    expect(lineToggle).toBeDefined()

    const texts = renderer!.root.findAll((node) => String(node.type) === 'Text')
    const pathText = texts.find((node) => node.props.children === 'docs/README.md')
    expect(pathText).toBeDefined()
  })

  it('remembers source view mode across unmount and remount when switching tabs', () => {
    act(() => {
      renderer = create(
        createElement(MarkdownReader, {
          documentId: 'tab-readme',
          doc,
          title: 'README.md',
          relativePath: 'README.md',
          onCopy,
          onCopyPath,
          onSave,
          onDiscard,
          onRefresh,
          onChange: vi.fn(),
          keyboardLift: 0
        })
      )
    })

    const viewToggle = buttons().find(
      (node) => node.props.accessibilityLabel === 'View Markdown source'
    )
    expect(viewToggle).toBeDefined()
    act(() => viewToggle!.props.onPress())

    expect(
      buttons().find((node) => node.props.accessibilityLabel === 'View rich editor')
    ).toBeDefined()

    // Simulate switching away (unmount)
    act(() => renderer?.unmount())

    // Simulate switching back (remount)
    act(() => {
      renderer = create(
        createElement(MarkdownReader, {
          documentId: 'tab-readme',
          doc,
          title: 'README.md',
          relativePath: 'README.md',
          onCopy,
          onCopyPath,
          onSave,
          onDiscard,
          onRefresh,
          onChange: vi.fn(),
          keyboardLift: 0
        })
      )
    })

    // Should immediately be in source mode without resetting to editor
    expect(
      buttons().find((node) => node.props.accessibilityLabel === 'View rich editor')
    ).toBeDefined()
    expect(
      buttons().find((node) => node.props.accessibilityLabel === 'View Markdown source')
    ).toBeUndefined()
  })

  it('preserves scroll ratio when switching between editor and source view', () => {
    act(() => {
      renderer = create(
        createElement(MarkdownReader, {
          documentId: 'tab-scroll',
          doc,
          title: 'DOC.md',
          relativePath: 'DOC.md',
          onCopy,
          onCopyPath,
          onSave,
          onDiscard,
          onRefresh,
          onChange: vi.fn(),
          keyboardLift: 0
        })
      )
    })

    // Initially in editor mode with initialScrollRatio = 0
    let editor = renderer!.root.findByType('MobileRichMarkdownEditor' as any)
    expect(editor.props.initialScrollRatio).toBe(0)

    // Simulate scrolling in rich editor
    act(() => {
      editor.props.onScrollRatioChange(0.65)
    })

    // Switch to source mode
    const viewToggle = buttons().find(
      (node) => node.props.accessibilityLabel === 'View Markdown source'
    )
    act(() => viewToggle!.props.onPress())

    // Source view should receive initialScrollRatio = 0.65
    const source = renderer!.root.findByType(MobileFilePreviewSourceText)
    expect(source.props.initialScrollRatio).toBe(0.65)

    // Simulate scrolling in source view to 0.8
    act(() => {
      source.props.onScrollRatioChange?.(0.8)
    })

    // Switch back to editor mode
    const editorToggle = buttons().find(
      (node) => node.props.accessibilityLabel === 'View rich editor'
    )
    act(() => editorToggle!.props.onPress())

    // Editor should remount with initialScrollRatio = 0.8
    editor = renderer!.root.findByType('MobileRichMarkdownEditor' as any)
    expect(editor.props.initialScrollRatio).toBe(0.8)
  })
})
