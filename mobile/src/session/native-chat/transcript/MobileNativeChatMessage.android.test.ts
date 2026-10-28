import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'

// Run the long-press actions-sheet path separately from the iOS inline-selection suite.
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
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Bot: 'Bot',
  Brain: 'Brain',
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  Copy: 'Copy',
  Eye: 'Eye',
  FileMinus2: 'FileMinus2',
  FilePen: 'FilePen',
  FilePlus2: 'FilePlus2',
  Folder: 'Folder',
  Globe: 'Globe',
  ListChecks: 'ListChecks',
  MessageSquareMore: 'MessageSquareMore',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Search: 'Search',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench'
}))
vi.mock('../../../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../visual/MobileNativeChatImageViewer', () => ({
  MobileNativeChatImageViewer: 'ImageViewer'
}))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'

const inChat = (...rows: NativeChatMessage[]) =>
  createElement(
    MobileNativeChatRowOverlaysHost,
    { conversation: { surfaceId: 'chat', sessionId: null } },
    rows.map((row) => createElement(MobileNativeChatMessage, { key: row.id, message: row }))
  )

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
      renderer = create(inChat(message))
    })
    expect(byType('MessageActionsSheet')).toHaveLength(0)
    expect(
      byType('Pressable').filter((node) => node.props.accessibilityLabel === 'Copy message')
    ).toHaveLength(1)

    const [bubble] = byType('Pressable')
    expect(typeof bubble!.props.onLongPress).toBe('function')
    const [markdown] = byType('MobileMarkdown')
    expect(markdown!.props.onLongPress).toBe(bubble!.props.onLongPress)
    expect(markdown!.props.rangeSelectable).toBe(true)

    act(() => bubble!.props.onLongPress())
    const [sheet] = byType('MessageActionsSheet')
    expect(sheet!.props.message).toBe(message)

    act(() => sheet!.props.onClose())
    expect(byType('MessageActionsSheet')).toHaveLength(0)
  })

  it('opens the actions sheet from a long press on an attached picture, not the viewer', () => {
    act(() => {
      renderer = create(
        inChat({
          ...message,
          role: 'user',
          blocks: [
            { type: 'text', text: 'Here is the screen.' },
            { type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }
          ]
        })
      )
    })
    const [bubble] = byType('Pressable')
    const picture = renderer!.root.findByProps({ accessibilityRole: 'imagebutton' })
    expect(picture.props.onLongPress).toBe(bubble!.props.onLongPress)
    act(() => picture.props.onLongPress())
    expect(byType('MessageActionsSheet')).toHaveLength(1)
  })

  it('disables inline selection for host notices too', () => {
    act(() => {
      renderer = create(
        inChat({
          ...message,
          role: 'system',
          blocks: [{ type: 'text', text: 'fallback', presentation: 'history-item-too-large' }]
        })
      )
    })
    const texts = byType('Text').filter((node) => node.props.selectable !== undefined)
    expect(texts).toHaveLength(1)
    expect(texts[0]!.props.selectable).toBe(false)
    act(() => byType('Pressable')[0]!.props.onLongPress())
    expect(byType('MessageActionsSheet')).toHaveLength(1)
  })

  it("opens the actions sheet from a long press on a plan's link", () => {
    act(() => {
      renderer = create(
        inChat({
          ...message,
          role: 'system',
          blocks: [
            {
              type: 'text',
              text: '1. Read [the guide](https://example.com)',
              presentation: 'plan-document'
            }
          ]
        })
      )
    })
    const [bubble] = byType('Pressable')
    const [plan] = byType('MobileMarkdown')
    expect(plan!.props.onLongPress).toBe(bubble!.props.onLongPress)
    act(() => plan!.props.onLongPress())
    expect(byType('MessageActionsSheet')).toHaveLength(1)
  })

  it('opens the actions sheet from a long press on an expanded reasoning row, not on its headline', () => {
    const reasoning: NativeChatMessage = {
      ...message,
      id: 'r1',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing two approaches' }],
      timestamp: 1_000,
      state: 'completed',
      completedAt: 4_000
    }
    act(() => {
      renderer = create(inChat(reasoning))
    })
    const [toggle] = byType('Pressable')
    expect(toggle!.props.onLongPress).toBeUndefined()
    act(() => toggle!.props.onPress())

    const body = byType('Pressable').find((node) => node.props.onLongPress !== undefined)
    expect(typeof body?.props.onLongPress).toBe('function')
    const [markdown] = byType('MobileMarkdown')
    expect(markdown!.props.onLongPress).toBe(body!.props.onLongPress)

    act(() => body!.props.onLongPress())
    const [sheet] = byType('MessageActionsSheet')
    expect(sheet!.props.message).toBe(reasoning)
    act(() => sheet!.props.onClose())
    expect(byType('MessageActionsSheet')).toHaveLength(0)
  })

  it('keeps the actions sheet open while the transcript row replaces the sent message under it', () => {
    const echo: NativeChatMessage = {
      ...message,
      id: 'pending-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Follow-up for the sheet test.' }]
    }
    act(() => {
      renderer = create(inChat(message, echo))
    })
    const bodies = byType('Pressable').filter((node) => node.props.onLongPress !== undefined)
    act(() => bodies.at(-1)!.props.onLongPress())
    expect(byType('MessageActionsSheet').map((sheet) => sheet.props.message.id)).toEqual([
      'pending-1'
    ])

    act(() => renderer!.update(inChat(message, { ...echo, id: 'transcript-7' })))
    expect(byType('MessageActionsSheet').map((sheet) => sheet.props.message.id)).toEqual([
      'pending-1'
    ])
  })

  it('renders the user bubble without inline selection', () => {
    act(() => {
      renderer = create(inChat({ ...message, id: 'u1', role: 'user' }))
    })
    const [markdown, ...others] = byType('MobileMarkdown')
    expect(others).toHaveLength(0)
    expect(markdown?.props).toMatchObject({ rangeSelectable: true, tone: 'userMessage' })
    expect(markdown?.props.onLongPress).toEqual(expect.any(Function))
    expect(
      byType('Pressable').filter((node) => node.props.accessibilityLabel === 'Copy message')
    ).toHaveLength(1)
    act(() => byType('Pressable')[0]!.props.onLongPress())
    expect(byType('MessageActionsSheet')).toHaveLength(1)
  })
})
