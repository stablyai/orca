import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileFilePreviewSourceText } from './MobileFilePreviewSourceText'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value }
}))

vi.mock('../components/MobileSyntaxSegments', () => ({
  MobileSyntaxSegments: 'MobileSyntaxSegments'
}))

vi.mock('./mobile-file-preview-styles', () => ({
  filePreviewStyles: {
    scroll: {},
    textContent: {},
    textContentWithLines: {},
    textPreview: {},
    sourceLinesContainer: {},
    sourceLineRow: { minHeight: 19 },
    sourceLineRowTarget: { backgroundColor: 'rgba(59, 130, 246, 0.2)' },
    sourceLineNumber: {},
    sourceLineNumberTarget: { fontWeight: '700' },
    sourceLineText: {},
    truncatedNote: {}
  }
}))

vi.mock('./mobile-file-preview-syntax', () => ({
  buildMobileFilePreviewSyntax: (_path: string, content: string) => ({
    segments: [{ text: content, kind: 'plain' }],
    highlighted: false
  })
}))

describe('MobileFilePreviewSourceText line numbers', () => {
  it('renders line numbers gutter when showLineNumbers is true', async () => {
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(MobileFilePreviewSourceText, {
          relativePath: 'test.ts',
          content: 'line 1\nline 2\nline 3',
          showLineNumbers: true
        })
      )
    })
    if (!renderer) {
      throw new Error('Component failed to render')
    }
    const textNodes = findAllByHostType((renderer as ReactTestRenderer).root, 'Text')
    // Line number texts: 1, 2, 3
    const numbers = textNodes.map((n) => n.props.children).filter((c) => typeof c === 'number')
    expect(numbers).toEqual([1, 2, 3])

    const firstNumber = textNodes.find((n) => n.props.children === 1)
    expect([firstNumber?.props.style].flat()).toContainEqual(
      expect.objectContaining({ flexShrink: 0, minWidth: expect.any(Number) })
    )
  })

  it('renders single text block without line numbers when showLineNumbers is false', async () => {
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(MobileFilePreviewSourceText, {
          relativePath: 'test.ts',
          content: 'line 1\nline 2\nline 3',
          showLineNumbers: false
        })
      )
    })
    if (!renderer) {
      throw new Error('Component failed to render')
    }
    const textNodes = findAllByHostType((renderer as ReactTestRenderer).root, 'Text')
    const numbers = textNodes.map((n) => n.props.children).filter((c) => typeof c === 'number')
    expect(numbers).toHaveLength(0)
  })

  it('highlights the target initialLine row and line number', async () => {
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(MobileFilePreviewSourceText, {
          relativePath: 'test.md',
          content: 'first\nsecond\nthird',
          initialLine: 2,
          showLineNumbers: true
        })
      )
    })
    if (!renderer) {
      throw new Error('Component failed to render')
    }
    const viewNodes = findAllByHostType((renderer as ReactTestRenderer).root, 'View')
    const targetRow = viewNodes.find((v) =>
      [v.props.style].flat().some((s) => s?.backgroundColor === 'rgba(59, 130, 246, 0.2)')
    )
    expect(targetRow).toBeDefined()

    const textNodes = findAllByHostType((renderer as ReactTestRenderer).root, 'Text')
    const targetNumber = textNodes.find((n) => n.props.children === 2)
    expect([targetNumber?.props.style].flat()).toContainEqual(
      expect.objectContaining({ fontWeight: '700' })
    )
  })

  it('scrolls accurately to target line onLayout measurement', async () => {
    let renderer: ReactTestRenderer | null = null
    await act(async () => {
      renderer = create(
        createElement(MobileFilePreviewSourceText, {
          relativePath: 'test.md',
          content: 'first\nsecond\nthird',
          initialLine: 2,
          showLineNumbers: true
        })
      )
    })
    if (!renderer) {
      throw new Error('Component failed to render')
    }
    const viewNodes = findAllByHostType((renderer as ReactTestRenderer).root, 'View')
    const targetRow = viewNodes.find((v) => typeof v.props.onLayout === 'function')
    expect(targetRow).toBeDefined()

    // Trigger onLayout with an exact measured y
    await act(async () => {
      targetRow?.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 154, width: 360, height: 38 } }
      })
    })
  })
})
