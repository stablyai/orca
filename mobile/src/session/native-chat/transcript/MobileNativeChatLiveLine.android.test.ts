import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveReasoning } from '../../../../../src/shared/native-chat/transcript/native-chat-reasoning-row'

// Android lacks inline selection; exercise the message-actions copy path separately from iOS.
vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }): ReactNode =>
      React.createElement(name, props, children)
  return {
    ActivityIndicator: host('ActivityIndicator'),
    Platform: { OS: 'android' },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))
vi.mock('../../../components/LoadingSpinner', () => ({ LoadingSpinner: 'LoadingSpinner' }))
vi.mock('./MobileNativeChatReasoningRow', () => ({
  MobileNativeChatReasoningBody: 'ReasoningBody'
}))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('../visual/MobileNativeChatImageViewer', () => ({
  MobileNativeChatImageViewer: 'ImageViewer'
}))

import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'

const block: NativeChatLiveReasoning = {
  message: {
    id: 'r-1',
    role: 'reasoning',
    blocks: [{ type: 'text', text: 'Weighing two approaches' }],
    timestamp: null,
    source: 'transcript',
    state: 'running'
  },
  markdown: 'Weighing two approaches'
}

const chat = (reasoning: NativeChatLiveReasoning | null | undefined) =>
  createElement(
    MobileNativeChatRowOverlaysHost,
    { conversation: { surfaceId: 'chat', sessionId: 's1' } },
    reasoning === undefined
      ? null
      : createElement(MobileNativeChatLiveLine, {
          line: {
            thinking: true,
            stopping: false,
            activityText: null,
            reasoning,
            reasoningExpanded: true
          },
          onToggleReasoning: vi.fn(),
          fontScale: 1
        })
  )

describe('MobileNativeChatLiveLine on Android', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const byType = (type: string): ReactTestInstance[] =>
    renderer!.root.findAll((node) => String(node.type) === type)
  const sheetIds = (): string[] =>
    byType('MessageActionsSheet').map((sheet) => sheet.props.message.id)

  it('opens the actions sheet for the live block from a long press on its text', () => {
    act(() => {
      renderer = create(chat(block))
    })
    expect(byType('MessageActionsSheet')).toHaveLength(0)

    act(() => byType('ReasoningBody')[0]!.props.onLongPress())
    const [sheet] = byType('MessageActionsSheet')
    expect(sheet?.props.message).toBe(block.message)

    act(() => sheet!.props.onClose())
    expect(byType('MessageActionsSheet')).toHaveLength(0)
  })

  it('keeps the sheet open when the turn finishes, and opens none for the next block by itself', () => {
    act(() => {
      renderer = create(chat(block))
    })
    act(() => byType('ReasoningBody')[0]!.props.onLongPress())
    act(() => renderer!.update(chat(undefined)))
    expect(sheetIds()).toEqual(['r-1'])

    act(() =>
      renderer!.update(chat({ message: { ...block.message, id: 'r-2' }, markdown: 'Next thought' }))
    )
    expect(sheetIds()).toEqual(['r-1'])
    act(() => byType('MessageActionsSheet')[0]!.props.onClose())
    expect(sheetIds()).toEqual([])
  })
})
