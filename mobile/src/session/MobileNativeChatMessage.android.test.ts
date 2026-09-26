import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

// Why a separate file: the sibling suite runs as iOS, where the row has no long press at all.
// This one runs as Android and pins the wiring from the bubble's long press to the actions sheet.
vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Image: 'Image',
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

const message: NativeChatMessage = {
  id: 'a1',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Read https://example.com then reply.' }],
  timestamp: null,
  source: 'transcript'
}

describe('MobileNativeChatMessage on Android', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function byType(type: string): ReactTestInstance[] {
    return renderer!.root.findAll((node) => String(node.type) === type)
  }

  it('opens the actions sheet from a long press on the bubble, and closes it again', () => {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message }))
    })
    expect(byType('MessageActionsSheet')).toHaveLength(0)

    const [bubble] = byType('Pressable')
    expect(typeof bubble!.props.onLongPress).toBe('function')
    // The markdown gets the same handler, so a link span or image under the finger opens the sheet.
    const [markdown] = byType('MobileMarkdown')
    expect(markdown!.props.onLongPress).toBe(bubble!.props.onLongPress)
    expect(markdown!.props.rangeSelectable).toBe(true)

    act(() => bubble!.props.onLongPress())
    const [sheet] = byType('MessageActionsSheet')
    expect(sheet!.props.message).toBe(message)

    act(() => sheet!.props.onClose())
    expect(byType('MessageActionsSheet')).toHaveLength(0)
  })

  it('renders the user bubble without inline selection', () => {
    act(() => {
      renderer = create(
        createElement(MobileNativeChatMessage, { message: { ...message, id: 'u1', role: 'user' } })
      )
    })
    const texts = byType('Text').filter((node) => node.props.selectable !== undefined)
    expect(texts.length).toBeGreaterThan(0)
    for (const node of texts) {
      expect(node.props.selectable).toBe(false)
    }
  })
})
