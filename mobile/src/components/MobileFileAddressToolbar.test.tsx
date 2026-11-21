import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileFileAddressToolbar } from './MobileFileAddressToolbar'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))

vi.mock('lucide-react-native', () => ({
  BookOpen: 'BookOpen',
  Code: 'Code',
  ListOrdered: 'ListOrdered',
  Copy: 'Copy',
  Check: 'Check'
}))

vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: vi.fn().mockResolvedValue(undefined) })
}))

describe('MobileFileAddressToolbar', () => {
  it('renders path text and copy button', () => {
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(MobileFileAddressToolbar, {
          path: 'src/index.ts',
          content: 'console.log("hello")'
        })
      )
    })
    const texts = findAllByHostType(renderer!.root, 'Text')
    expect(texts.some((t) => t.props.children === 'src/index.ts')).toBe(true)

    const buttons = findAllByHostType(renderer!.root, 'Pressable')
    const copyButton = buttons.find((b) => b.props.accessibilityLabel === 'Copy file content')
    expect(copyButton).toBeDefined()
  })

  it('renders line number toggle on the left and handles toggle press', () => {
    const onToggle = vi.fn()
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(MobileFileAddressToolbar, {
          path: 'src/main.rs',
          showLineNumbers: true,
          onToggleLineNumbers: onToggle
        })
      )
    })
    const buttons = findAllByHostType(renderer!.root, 'Pressable')
    const lineToggle = buttons.find((b) => b.props.accessibilityLabel === 'Hide line numbers')
    expect(lineToggle).toBeDefined()
    expect(lineToggle?.props.accessibilityRole).toBe('button')
    expect(lineToggle?.props.accessibilityState.selected).toBe(true)

    act(() => {
      lineToggle?.props.onPress()
    })
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('omits line number toggle when in preview viewMode', () => {
    const onToggle = vi.fn()
    const onModeChange = vi.fn()
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(MobileFileAddressToolbar, {
          path: 'README.md',
          viewMode: 'preview',
          onViewModeChange: onModeChange,
          showLineNumbers: true,
          onToggleLineNumbers: onToggle
        })
      )
    })
    const buttons = findAllByHostType(renderer!.root, 'Pressable')
    const lineToggle = buttons.find(
      (b) =>
        b.props.accessibilityLabel === 'Hide line numbers' ||
        b.props.accessibilityLabel === 'Show line numbers'
    )
    expect(lineToggle).toBeUndefined()

    // Mode toggles should still be present
    const sourceToggle = buttons.find((b) => b.props.accessibilityLabel === 'View Markdown source')
    expect(sourceToggle).toBeDefined()
    act(() => {
      sourceToggle?.props.onPress()
    })
    expect(onModeChange).toHaveBeenCalledWith('source')
  })

  it('shows line number toggle when in source viewMode', () => {
    const onToggle = vi.fn()
    const onModeChange = vi.fn()
    let renderer: ReactTestRenderer | null = null
    act(() => {
      renderer = create(
        createElement(MobileFileAddressToolbar, {
          path: 'README.md',
          viewMode: 'source',
          onViewModeChange: onModeChange,
          showLineNumbers: false,
          onToggleLineNumbers: onToggle
        })
      )
    })
    const buttons = findAllByHostType(renderer!.root, 'Pressable')
    const lineToggle = buttons.find((b) => b.props.accessibilityLabel === 'Show line numbers')
    expect(lineToggle).toBeDefined()
    expect(lineToggle?.props.accessibilityState.selected).toBe(false)
  })
})
