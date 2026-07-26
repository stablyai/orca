import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

const list = vi.hoisted(() => ({
  scrollToEnd: vi.fn(),
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn()
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props: Record<string, unknown>, ref) => {
      React.useImperativeHandle(ref, () => list)
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 24 }) }))
vi.mock('../localization/mobile-locale-provider', async () => {
  const { english } = await import('../localization/catalogs/en')
  return { useMobileLocale: () => ({ t: (key: keyof typeof english) => english[key] }) }
})
vi.mock('react-native-gesture-handler', async () => {
  const React = await import('react')
  return {
    GestureDetector: ({ children }: { children: unknown }) =>
      React.createElement('GestureDetector', {}, children),
    GestureHandlerRootView: ({ children }: { children: unknown }) =>
      React.createElement('GestureHandlerRootView', {}, children)
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./use-mobile-native-chat-ask-dismiss', () => ({
  useMobileNativeChatAskDismiss: () => ({ askKey: null, showAsk: false, dismissAsk: vi.fn() })
}))
vi.mock('./use-mobile-native-chat-pinch-gesture', () => ({
  useMobileNativeChatPinchGesture: () => ({ fontScale: 1, pinchGesture: {} })
}))
vi.mock('./MobileAgentWorkingIndicator', () => ({ MobileAgentWorkingIndicator: 'Working' }))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'Message' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'Ask' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'Permission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'Question' }))

import { MobileNativeChatView } from './MobileNativeChatView'

const MESSAGE: NativeChatMessage = {
  id: 'm1',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'hello' }],
  timestamp: null,
  source: 'transcript'
}

const TOOL_CALL_MESSAGE: NativeChatMessage = {
  id: 'tool-call',
  role: 'assistant',
  blocks: [{ type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' } }],
  timestamp: null,
  source: 'transcript'
}

const TOOL_RESULT_MESSAGE: NativeChatMessage = {
  id: 'tool-result',
  role: 'tool',
  blocks: [{ type: 'tool-result', output: 'line 1' }],
  timestamp: null,
  source: 'transcript'
}

function viewProps(
  args: {
    sessionKey?: string
    keyboardInset?: number
    streamingText?: string
    messages?: NativeChatMessage[]
    agentWorking?: boolean
    onSend?: (text: string) => Promise<boolean>
  } = {}
) {
  return {
    sessionKey: args.sessionKey ?? 'session-1',
    messages: args.messages ?? [MESSAGE],
    status: 'ready' as const,
    onSend: args.onSend ?? vi.fn().mockResolvedValue(true),
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    keyboardInset: args.keyboardInset ?? 0,
    streamingText: args.streamingText,
    agentWorking: args.agentWorking
  }
}

function scrollEvent(
  offsetY: number,
  contentHeight = 1000,
  layoutHeight = 400,
  velocityY?: number
) {
  return {
    nativeEvent: {
      contentOffset: { y: offsetY },
      contentSize: { height: contentHeight },
      layoutMeasurement: { height: layoutHeight },
      velocity: velocityY === undefined ? undefined : { x: 0, y: velocityY }
    }
  }
}

describe('MobileNativeChatView scroll ownership', () => {
  let renderer: ReactTestRenderer

  function clearTailCommands(): void {
    list.scrollToEnd.mockClear()
    list.scrollToOffset.mockClear()
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle)
    )
    clearTailCommands()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  async function render(props = viewProps()) {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await act(async () => {
      renderer = create(createElement(MobileNativeChatView, props))
      await vi.runAllTimersAsync()
    })
    error.mockRestore()
    clearTailCommands()
  }

  function flatList() {
    return renderer.root.findByType('FlatList')
  }

  function expectTailCommandCount(count: number): void {
    expect(list.scrollToEnd.mock.calls.length + list.scrollToOffset.mock.calls.length).toBe(count)
  }

  function expectTailCommandAnimation(animated: boolean): void {
    const calls = [...list.scrollToEnd.mock.calls, ...list.scrollToOffset.mock.calls]
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toEqual(expect.objectContaining({ animated }))
  }

  it('gives a drag ownership before its first offset event', async () => {
    await render()

    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(600))
      flatList().props.onContentSizeChange()
    })
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(0)
  })

  it('coalesces a keyboard layout transition into one bottom command', async () => {
    await render()

    await act(async () => {
      renderer.update(createElement(MobileNativeChatView, viewProps({ keyboardInset: 320 })))
      flatList().props.onContentSizeChange()
      flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(1)
  })

  it('keeps following when content grows before the programmatic offset catches up', async () => {
    await render(viewProps({ streamingText: 'partial' }))
    act(() => flatList().props.onScroll(scrollEvent(500, 1100)))
    clearTailCommands()

    await act(async () => {
      renderer.update(
        createElement(MobileNativeChatView, viewProps({ streamingText: 'partial grows' }))
      )
      flatList().props.onContentSizeChange()
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(1)
  })

  it('keeps one scroll owner while an existing tool row grows at the tail', async () => {
    await render(viewProps({ messages: [MESSAGE, TOOL_CALL_MESSAGE] }))
    act(() => flatList().props.onScroll(scrollEvent(600)))
    clearTailCommands()

    await act(async () => {
      renderer.update(
        createElement(
          MobileNativeChatView,
          viewProps({ messages: [MESSAGE, TOOL_CALL_MESSAGE, TOOL_RESULT_MESSAGE] })
        )
      )
      flatList().props.onContentSizeChange(320, 1120)
      await vi.runAllTimersAsync()
    })

    expect(flatList().props.maintainVisibleContentPosition).toBeUndefined()
    expectTailCommandCount(1)
  })

  it('pins a growing tool row to the measured tail instead of remeasuring the list end', async () => {
    await render(viewProps({ messages: [MESSAGE, TOOL_CALL_MESSAGE] }))
    act(() => flatList().props.onScroll(scrollEvent(600)))

    await act(async () => {
      renderer.update(
        createElement(
          MobileNativeChatView,
          viewProps({ messages: [MESSAGE, TOOL_CALL_MESSAGE, TOOL_RESULT_MESSAGE] })
        )
      )
      flatList().props.onContentSizeChange(320, 1120)
      await vi.runAllTimersAsync()
    })

    expect(list.scrollToEnd).not.toHaveBeenCalled()
    expect(list.scrollToOffset).toHaveBeenCalledTimes(1)
    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 720, animated: false })
  })

  it.each([
    ['content size first', ['content', 'layout']],
    ['layout first', ['layout', 'content']]
  ] as const)(
    'pins the measured tail without a prior scroll event when %s',
    async (_label, order) => {
      await render(viewProps({ messages: [MESSAGE, TOOL_CALL_MESSAGE] }))

      act(() => {
        for (const measurement of order) {
          if (measurement === 'content') {
            flatList().props.onContentSizeChange(320, 1120)
          } else {
            flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
          }
        }
      })
      await act(() => vi.runAllTimersAsync())

      expect(list.scrollToEnd).not.toHaveBeenCalled()
      expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 720, animated: false })
    }
  )

  it('does not move a growing tool row while the user drags through history', async () => {
    await render(viewProps({ messages: [MESSAGE, TOOL_CALL_MESSAGE], agentWorking: true }))
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScroll(scrollEvent(350))
      renderer.update(
        createElement(
          MobileNativeChatView,
          viewProps({
            messages: [MESSAGE, TOOL_CALL_MESSAGE, TOOL_RESULT_MESSAGE],
            agentWorking: true
          })
        )
      )
      flatList().props.onContentSizeChange(320, 1120)
    })
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(0)
  })

  it('does not follow streaming output while the user reads history', async () => {
    await render(viewProps({ streamingText: 'partial' }))
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500, 1100))
      flatList().props.onScroll(scrollEvent(400, 1100))
      flatList().props.onScrollEndDrag(scrollEvent(400, 1100))
    })
    await act(() => vi.runAllTimersAsync())
    clearTailCommands()

    await act(async () => {
      renderer.update(
        createElement(MobileNativeChatView, viewProps({ streamingText: 'partial grows' }))
      )
      flatList().props.onContentSizeChange()
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(0)
  })

  it('preserves history through working updates and repeated keyboard transitions', async () => {
    await render(viewProps({ agentWorking: true, streamingText: 'partial' }))
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500, 1100))
      flatList().props.onScroll(scrollEvent(300, 1100))
      flatList().props.onScrollEndDrag(scrollEvent(300, 1100))
    })
    await act(() => vi.runAllTimersAsync())
    clearTailCommands()

    for (const keyboardInset of [280, 340, 0]) {
      await act(async () => {
        renderer.update(
          createElement(
            MobileNativeChatView,
            viewProps({
              agentWorking: true,
              keyboardInset,
              streamingText: `partial-${keyboardInset}`
            })
          )
        )
        flatList().props.onContentSizeChange()
        flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
        await vi.runAllTimersAsync()
      })
    }

    expect(renderer.root.findByType('Working')).toBeDefined()
    expectTailCommandCount(0)
    expect(
      renderer.root.find(
        (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Scroll to latest'
      )
    ).toBeDefined()
  })

  it('does not reclaim ownership while drag momentum is still running', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScroll(scrollEvent(400))
      flatList().props.onScrollEndDrag(scrollEvent(400))
      flatList().props.onMomentumScrollBegin(scrollEvent(400))
      flatList().props.onContentSizeChange()
    })
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(0)
    act(() => flatList().props.onMomentumScrollEnd(scrollEvent(400)))
    expectTailCommandCount(0)
  })

  it('catches up once after downward momentum reaches the working stream tail', async () => {
    await render(viewProps({ agentWorking: true, streamingText: 'partial' }))
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(300))
      flatList().props.onScrollEndDrag(scrollEvent(500))
      flatList().props.onMomentumScrollBegin(scrollEvent(500))
      renderer.update(
        createElement(
          MobileNativeChatView,
          viewProps({ agentWorking: true, streamingText: 'partial grows' })
        )
      )
      flatList().props.onContentSizeChange()
    })
    await act(() => vi.runAllTimersAsync())
    expectTailCommandCount(0)

    act(() => flatList().props.onMomentumScrollEnd(scrollEvent(600)))
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(1)
  })

  it('catches up once when a working stream grows as a downward drag settles at the tail', async () => {
    await render(viewProps({ agentWorking: true, streamingText: 'partial' }))
    expect(renderer.root.findByType('Working')).toBeDefined()

    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(400, 1000))
      flatList().props.onScroll(scrollEvent(600, 1000))
      flatList().props.onScrollEndDrag(scrollEvent(600, 1000))
      renderer.update(
        createElement(
          MobileNativeChatView,
          viewProps({
            agentWorking: true,
            keyboardInset: 320,
            streamingText: 'partial grows'
          })
        )
      )
      flatList().props.onContentSizeChange()
      flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
    })
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(1)
  })

  it('ignores a late momentum start after a drag settles without velocity', async () => {
    await render(viewProps({ agentWorking: true, streamingText: 'partial' }))
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScrollEndDrag(scrollEvent(600))
    })
    await act(() => vi.runAllTimersAsync())
    clearTailCommands()

    await act(async () => {
      flatList().props.onMomentumScrollBegin(scrollEvent(600))
      renderer.update(
        createElement(
          MobileNativeChatView,
          viewProps({ agentWorking: true, streamingText: 'partial grows' })
        )
      )
      flatList().props.onContentSizeChange()
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(1)
  })

  it('settles from the latest viewport after a layout change crosses into the tail', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500, 1000, 400))
      flatList().props.onScrollEndDrag(scrollEvent(500, 1000, 400))
      flatList().props.onLayout({ nativeEvent: { layout: { height: 450 } } })
    })
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(1)
  })

  it('does not reclaim the tail when a layout change moves the user out of range', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(560, 1000, 400))
      flatList().props.onScrollEndDrag(scrollEvent(560, 1000, 400))
      flatList().props.onLayout({ nativeEvent: { layout: { height: 300 } } })
    })
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(0)
  })

  it('does not reclaim ownership while a signaled momentum start is delayed', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(600))
      flatList().props.onScrollEndDrag(scrollEvent(600, 1000, 400, 1.5))
    })
    await act(() => vi.runAllTimersAsync())

    act(() => {
      flatList().props.onContentSizeChange()
    })
    await act(() => vi.runAllTimersAsync())
    expectTailCommandCount(0)

    act(() => {
      flatList().props.onMomentumScrollBegin(scrollEvent(600))
      flatList().props.onContentSizeChange()
    })
    await act(() => vi.runAllTimersAsync())
    expectTailCommandCount(0)
  })

  it('ignores stale momentum completion after a new drag starts', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScrollEndDrag(scrollEvent(400))
      flatList().props.onMomentumScrollBegin(scrollEvent(400))
      flatList().props.onScrollBeginDrag(scrollEvent(300))
      flatList().props.onMomentumScrollEnd(scrollEvent(600))
      flatList().props.onContentSizeChange()
    })
    await act(() => vi.runAllTimersAsync())

    expectTailCommandCount(0)
  })

  it('ignores stale momentum start after an accepted send resumes following', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(400))
      flatList().props.onScrollEndDrag(scrollEvent(400))
    })
    await act(() => vi.runAllTimersAsync())
    const composer = renderer.root.findByType('Composer')

    await act(async () => {
      await composer.props.onSend('hello')
      flatList().props.onMomentumScrollBegin(scrollEvent(400))
      await vi.runAllTimersAsync()
    })

    expectTailCommandAnimation(true)
  })

  it('ignores stale momentum start after another session resets the scroll state', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(400))
      flatList().props.onScrollEndDrag(scrollEvent(400))
    })
    await act(() => vi.runAllTimersAsync())
    const staleMomentumBegin = flatList().props.onMomentumScrollBegin
    clearTailCommands()

    await act(() => {
      renderer.update(createElement(MobileNativeChatView, viewProps({ sessionKey: 'session-2' })))
    })
    await act(async () => {
      staleMomentumBegin(scrollEvent(400))
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(1)
  })

  it('makes an explicit jump the new tail-following intent', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScroll(scrollEvent(400))
      flatList().props.onScrollEndDrag(scrollEvent(400))
    })
    await act(() => vi.runAllTimersAsync())
    const jump = renderer.root.find(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Scroll to latest'
    )
    clearTailCommands()

    act(() => jump.props.onPress())
    await act(() => vi.runAllTimersAsync())

    expectTailCommandAnimation(true)
  })

  it('makes an accepted send resume tail following from history', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScroll(scrollEvent(400))
      flatList().props.onScrollEndDrag(scrollEvent(400))
    })
    await act(() => vi.runAllTimersAsync())
    clearTailCommands()
    const composer = renderer.root.findByType('Composer')

    await act(async () => {
      await composer.props.onSend('hello')
      await vi.runAllTimersAsync()
    })

    expectTailCommandAnimation(true)
  })

  it('keeps the user in history when sending is rejected', async () => {
    const onSend = vi.fn().mockResolvedValue(false)
    await render(viewProps({ onSend }))
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScroll(scrollEvent(400))
      flatList().props.onScrollEndDrag(scrollEvent(400))
    })
    await act(() => vi.runAllTimersAsync())
    clearTailCommands()

    await act(async () => {
      await renderer.root.findByType('Composer').props.onSend('hello')
      await vi.runAllTimersAsync()
    })

    expect(onSend).toHaveBeenCalledWith('hello')
    expectTailCommandCount(0)
  })

  it('does not move history for a keyboard layout change', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(500))
      flatList().props.onScroll(scrollEvent(400))
      flatList().props.onScrollEndDrag(scrollEvent(400))
    })
    await act(() => vi.runAllTimersAsync())
    clearTailCommands()

    await act(async () => {
      renderer.update(createElement(MobileNativeChatView, viewProps({ keyboardInset: 320 })))
      flatList().props.onContentSizeChange()
      flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(0)
  })

  it('resets history-reading intent when another chat session opens', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(100))
      flatList().props.onScroll(scrollEvent(100))
      flatList().props.onScrollEndDrag(scrollEvent(100))
    })
    await act(() => vi.runAllTimersAsync())
    clearTailCommands()

    const nextMessage = { ...MESSAGE, id: 'other-session-message' }
    await act(async () => {
      renderer.update(
        createElement(
          MobileNativeChatView,
          viewProps({ sessionKey: 'session-2', messages: [nextMessage] })
        )
      )
    })
    await act(async () => {
      flatList().props.onContentSizeChange()
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(1)
  })

  it('anchors the visible message while older history is prepended', async () => {
    await render()
    act(() => {
      flatList().props.onScrollBeginDrag(scrollEvent(100))
      flatList().props.onScroll(scrollEvent(100))
      flatList().props.onScrollEndDrag(scrollEvent(100))
    })
    await act(() => vi.runAllTimersAsync())

    expect(flatList().props.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0
    })
  })

  it('shrinks the chat viewport above the keyboard without padding message content', async () => {
    await render(viewProps({ keyboardInset: 320 }))
    const root = renderer.root.findAllByType('View')[0]

    expect(root.props.style).toEqual(expect.arrayContaining([{ paddingBottom: 344 }]))
    expect(flatList().props.style).toEqual(
      expect.objectContaining({
        flex: 1,
        minHeight: 0
      })
    )
    expect(flatList().props.contentContainerStyle).not.toEqual(
      expect.arrayContaining([{ paddingBottom: 320 }])
    )
  })

  it('does not scroll again for duplicate settled viewport measurements', async () => {
    await render()

    await act(async () => {
      flatList().props.onContentSizeChange(320, 1000)
      flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
      await vi.runAllTimersAsync()
    })
    expectTailCommandCount(1)
    clearTailCommands()

    await act(async () => {
      flatList().props.onContentSizeChange(320, 1000)
      flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
      await vi.runAllTimersAsync()
    })

    expectTailCommandCount(0)
  })

  it('coalesces every keyboard height transition while following the tail', async () => {
    await render(viewProps({ agentWorking: true, streamingText: 'partial' }))

    for (const keyboardInset of [280, 340, 0]) {
      clearTailCommands()
      await act(async () => {
        renderer.update(
          createElement(
            MobileNativeChatView,
            viewProps({ agentWorking: true, keyboardInset, streamingText: 'partial' })
          )
        )
        flatList().props.onContentSizeChange()
        flatList().props.onLayout({ nativeEvent: { layout: { height: 400 } } })
        await vi.runAllTimersAsync()
      })
      expectTailCommandCount(1)
    }
  })
})
