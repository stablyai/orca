import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

type FlatListMockProps = {
  data?: NativeChatMessage[]
  onContentSizeChange?: (width: number, height: number) => void
  [key: string]: unknown
}

const measuredHeight = vi.hoisted<{ value: number | null }>(() => ({ value: null }))
const scrollToOffset = vi.hoisted(() => vi.fn())

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef<{ scrollToOffset: typeof scrollToOffset }, FlatListMockProps>(
      (props, ref) => {
        const { onContentSizeChange } = props
        React.useImperativeHandle(ref, () => ({ scrollToOffset }), [])
        React.useEffect(() => {
          if (measuredHeight.value !== null) {
            onContentSizeChange?.(320, measuredHeight.value)
          }
        }, [onContentSizeChange])
        return React.createElement('FlatList', { ...props, testID: 'mobile-chat-list' })
      }
    ),
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }))
vi.mock('react-native-gesture-handler', () => {
  const chain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
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
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

function message(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function view(folded: NativeChatMessage[], sendSurfaceId = 'tab-a') {
  return createElement(MobileNativeChatView, {
    messages: [],
    folded,
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId,
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn()
  })
}

describe('MobileNativeChatView transcript measurement', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    measuredHeight.value = null
    scrollToOffset.mockReset()
  })

  it('remounts and measures a replacement transcript, while preserving an unchanged identity', async () => {
    measuredHeight.value = 900
    await act(async () => {
      renderer = create(view([message('first', 'same height')]))
    })
    const first = renderer!.root.find((node) => node.props.testID === 'mobile-chat-list')
    expect(first.props.data.map((row: NativeChatMessage) => row.id)).toEqual(['first'])
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 900 })

    scrollToOffset.mockClear()
    await act(async () => {
      renderer!.update(view([message('second', 'same height')], 'tab-b'))
    })
    const second = renderer!.root.find((node) => node.props.testID === 'mobile-chat-list')
    expect(second).not.toBe(first)
    expect(scrollToOffset).toHaveBeenCalledTimes(1)
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 900 })

    act(() => {
      second.props.onScrollBeginDrag?.({})
      second.props.onScroll?.({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
    })
    scrollToOffset.mockClear()

    await act(async () => {
      renderer!.update(
        view([message('second', 'updated text'), message('append', 'new row')], 'tab-b')
      )
    })
    expect(renderer!.root.find((node) => node.props.testID === 'mobile-chat-list')).toBe(second)
    expect(scrollToOffset).not.toHaveBeenCalled()

    act(() => second.props.onContentSizeChange?.(320, 1_200))
    expect(scrollToOffset).not.toHaveBeenCalled()
    const jump = renderer!.root.find((node) => node.props.accessibilityLabel === 'Scroll to latest')
    act(() => jump.props.onPress())
    expect(scrollToOffset).toHaveBeenCalledWith({ animated: false, offset: 1_200 })
  })
})
