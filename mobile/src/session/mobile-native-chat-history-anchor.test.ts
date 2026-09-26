import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

const scrollToEnd = vi.hoisted(() => vi.fn())
const scrollToOffset = vi.hoisted(() => vi.fn())

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd, scrollToOffset }), [])
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('react-native-gesture-handler', () => {
  const chain = {
    runOnJS: () => chain,
    onStart: () => chain,
    onUpdate: () => chain
  }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))

vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))

function row(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function element(overrides: {
  messages: NativeChatMessage[]
  sendSurfaceId?: string
  onLoadEarlier?: () => void
}): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, {
    messages: overrides.messages,
    folded: overrides.messages,
    status: 'ready',
    streaming: null,
    hasMore: true,
    onLoadEarlier: overrides.onLoadEarlier,
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId: overrides.sendSurfaceId ?? 'tab-a',
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn()
  })
}

describe('mobile chat history anchor', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
  })

  function list(): ReactTestInstance {
    return renderer!.root.find(
      (node) =>
        typeof node.props.onContentSizeChange === 'function' &&
        typeof node.props.onScroll === 'function'
    )
  }

  function scroll(offsetY: number, height: number): void {
    act(() => {
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: offsetY },
          contentSize: { height },
          layoutMeasurement: { height: 500 }
        }
      })
    })
  }

  it('holds the scrolled row when older history arrives after a streaming chunk', async () => {
    const onLoadEarlier = vi.fn()
    const visible = row('a1', 'visible')
    await act(async () => {
      renderer = create(element({ messages: [visible], onLoadEarlier }))
    })
    scrollToOffset.mockClear()

    scroll(20, 400)
    expect(onLoadEarlier).toHaveBeenCalledOnce()
    act(() => list().props.onContentSizeChange(320, 480))
    expect(scrollToOffset).not.toHaveBeenCalled()

    const older = row('a0', 'older')
    await act(async () => {
      renderer?.update(element({ messages: [older, visible], onLoadEarlier }))
    })
    act(() => list().props.onContentSizeChange(320, 900))

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 440 })
  })

  it('requests earlier history on the first near-top scroll of the next chat', async () => {
    const onLoadEarlier = vi.fn()
    await act(async () => {
      renderer = create(
        element({ messages: [row('a1', 'first')], onLoadEarlier, sendSurfaceId: 'tab-a' })
      )
    })

    scroll(40, 1_000)
    scroll(10, 1_000)
    expect(onLoadEarlier).toHaveBeenCalledOnce()

    await act(async () => {
      renderer?.update(
        element({ messages: [row('b1', 'second')], onLoadEarlier, sendSurfaceId: 'tab-b' })
      )
    })
    scroll(30, 1_000)

    expect(onLoadEarlier).toHaveBeenCalledTimes(2)
  })
})
