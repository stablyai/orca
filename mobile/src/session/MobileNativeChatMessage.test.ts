import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Image: 'Image',
    Pressable: 'Pressable',
    Text: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

function userMessage(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'u1', role: 'user', blocks, timestamp: null, source: 'transcript' }
}

describe('MobileNativeChatMessage image-ref rendering', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(message: NativeChatMessage, onOpenFile?: (target: unknown) => void) {
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      if (typeof a[0] === 'string' && a[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...a)
    })
    try {
      act(() => {
        renderer = create(createElement(MobileNativeChatMessage, { message, onOpenFile }))
      })
    } finally {
      spy.mockRestore()
    }
    return renderer!
  }

  it('renders a loadable preview URI as an image thumbnail', () => {
    const tree = render(userMessage([{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }]))
    const image = tree.root.findByType('Image' as never)
    expect(image.props.source).toEqual({ uri: 'file:///a.jpg' })
    expect(image.props.accessibilityLabel).toBe('a photo')
  })

  it('prefers the url over the path when both are present', () => {
    const tree = render(
      userMessage([{ type: 'image-ref', url: 'file:///local.jpg', path: '/tmp/host.png' }])
    )
    expect(tree.root.findByType('Image' as never).props.source).toEqual({
      uri: 'file:///local.jpg'
    })
  })

  it('falls back to a text placeholder for a bare host path', () => {
    // A host temp path (e.g. on an SSH host) is not loadable on the device.
    const tree = render(userMessage([{ type: 'image-ref', path: '/tmp/host.png' }]))
    expect(tree.root.findAllByType('Image' as never)).toHaveLength(0)
    const texts = tree.root
      .findAllByType('Text' as never)
      .map((node) => String(node.children.join('')))
    expect(texts.some((text) => text.includes('/tmp/host.png'))).toBe(true)
  })

  it('opens a file path in the user bubble', () => {
    const onOpenFile = vi.fn()
    const path =
      '/Users/jinjingliang/Documents/projects/orca/worktree/docs/native-chat-rendering-architecture.md'
    const tree = render(userMessage([{ type: 'text', text: path }]), onOpenFile)
    const link = tree.root.find(
      (node) => node.type === 'Text' && node.props.accessibilityLabel === `Open file ${path}`
    )

    act(() => link.props.onPress())

    expect(onOpenFile).toHaveBeenCalledWith({
      pathText: path,
      line: null,
      column: null
    })
  })

  it('only makes the file span in surrounding user prose tappable', () => {
    const onOpenFile = vi.fn()
    const tree = render(
      userMessage([{ type: 'text', text: 'Please inspect src/app.ts before continuing' }]),
      onOpenFile
    )
    const outerText = tree.root
      .findAllByType('Text' as never)
      .find((node) => node.children.some((child) => String(child).includes('Please inspect')))
    const link = tree.root.find(
      (node) => node.type === 'Text' && node.props.accessibilityLabel === 'Open file src/app.ts'
    )

    expect(outerText?.props.onPress).toBeUndefined()
    expect(outerText?.props.accessibilityRole).toBeUndefined()
    act(() => link.props.onPress())
    expect(onOpenFile).toHaveBeenCalledWith({
      pathText: 'src/app.ts',
      line: null,
      column: null
    })
  })
})
