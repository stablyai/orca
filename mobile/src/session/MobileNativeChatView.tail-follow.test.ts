import { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  installChatViewHooks,
  assistantTurn,
  list,
  pressSend,
  render,
  root,
  scrollAwayFromTail,
  scrollToEnd,
  scrollToOffset,
  update
} from './MobileNativeChatView.harness.test-fixture'

vi.mock('react-native', async () => {
  const { reactNativeStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return reactNativeStub()
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', async () => {
  const { gestureHandlerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return gestureHandlerStub()
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./native-chat/composer/MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: tail-follow', () => {
  installChatViewHooks()

  it('lets content growth own streaming tail-follow without a delayed animated command', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Starting')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      scrollToEnd.mockClear()

      await update({ folded, streaming: 'Streaming output' })
      act(() => list().props.onContentSizeChange(320, 900))

      expect(scrollToOffset).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 900 })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToOffset).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat programmatic scroll metrics as user intent', async () => {
    const folded = [assistantTurn('a1', 'Latest')]
    await render({ folded })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onContentSizeChange(320, 1_300)
    })

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_300 })
    expect(
      root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
    ).toHaveLength(0)
  })

  it('keeps tail-follow paused across the drag-to-momentum handoff', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => list().props.onScrollBeginDrag?.({}))
      expect(
        root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)

      act(() => {
        list().props.onScroll({
          nativeEvent: {
            contentOffset: { y: 700 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onScrollEndDrag?.({
          nativeEvent: {
            contentOffset: { y: 700 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onContentSizeChange(320, 1_250)
        list().props.onMomentumScrollBegin?.({})
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 1_300))

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).not.toHaveBeenCalled()

      act(() => {
        list().props.onMomentumScrollEnd?.({
          nativeEvent: {
            contentOffset: { y: 800 },
            contentSize: { height: 1_300 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onContentSizeChange(320, 1_350)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_350 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses momentum-end metrics instead of a stale throttled scroll sample', async () => {
    const folded = [assistantTurn('a1', 'Latest')]
    await render({ folded })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 700 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onScrollEndDrag?.({
        nativeEvent: {
          contentOffset: { y: 700 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onMomentumScrollBegin?.({})
      list().props.onMomentumScrollEnd?.({
        nativeEvent: {
          contentOffset: { y: 200 },
          contentSize: { height: 1_300 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onContentSizeChange(320, 1_350)
    })

    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
    expect(
      root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
    ).toHaveLength(1)
  })

  it('uses finger-release metrics when no momentum event follows', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScroll({
          nativeEvent: {
            contentOffset: { y: 200 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onScrollEndDrag?.({
          nativeEvent: {
            contentOffset: { y: 620 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 1_250))

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_250 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('repins when content grows between tail release and drag settle', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      scrollToEnd.mockClear()

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScrollEndDrag?.({
          nativeEvent: {
            contentOffset: { y: 700 },
            contentSize: { height: 1_200 },
            layoutMeasurement: { height: 500 }
          }
        })
        list().props.onContentSizeChange(320, 1_250)
      })

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).not.toHaveBeenCalled()

      await act(async () => {
        vi.runOnlyPendingTimers()
      })

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      expect(
        root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses measured content height when the first message fills an empty transcript', async () => {
    await render()

    await pressSend()
    expect(scrollToEnd).not.toHaveBeenCalled()

    await update({ folded: [assistantTurn('a1', 'First response')] })
    act(() => list().props.onContentSizeChange(320, 1_200))

    expect(scrollToOffset).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_200 })
  })

  it('routes an accepted send through the immediate nonanimated tail owner', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'History')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      await scrollAwayFromTail()
      scrollToEnd.mockClear()

      await pressSend()

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes the latest-message chevron through the tail owner and resumes following', async () => {
    const folded = [assistantTurn('a1', 'History')]
    await render({ folded })
    await scrollAwayFromTail()
    scrollToEnd.mockClear()

    const chevron = root().find((node) => node.props.accessibilityLabel === 'Scroll to latest')
    act(() => chevron.props.onPress())
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })

    act(() => list().props.onContentSizeChange(320, 1_300))
    expect(scrollToEnd).toHaveBeenCalledOnce()
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_300 })
  })

  it('opens another chat at its newest message, following', async () => {
    const toolTurn = (id: string): ReturnType<typeof assistantTurn> => ({
      ...assistantTurn(id, ''),
      blocks: [{ type: 'tool-call', name: 'Bash', callId: id, input: { command: 'ls' } }]
    })
    await render({ folded: [assistantTurn('a1', 'Chat A'), toolTurn('a2')] })
    await scrollAwayFromTail()
    const control = (label: string) => root().findAllByProps({ accessibilityLabel: label })
    expect(control('Scroll to latest')).toHaveLength(1)
    scrollToEnd.mockClear()

    await update({
      folded: [assistantTurn('b1', 'Chat B'), toolTurn('b2')],
      sendSurfaceId: 'tab-b'
    })

    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false })
    expect(control('Scroll to latest')).toHaveLength(0)
    act(() => list().props.onContentSizeChange(320, 900))
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 900 })
  })

  it('starts an initially empty switched-to native chat following', async () => {
    const toolTurn = (id: string): ReturnType<typeof assistantTurn> => ({
      ...assistantTurn(id, ''),
      blocks: [{ type: 'tool-call', name: 'Bash', callId: id, input: { command: 'ls' } }]
    })
    await render({ folded: [toolTurn('a')] })
    await scrollAwayFromTail()
    await update({ sendSurfaceId: 'tab-b', folded: [] })
    await update({ sendSurfaceId: 'tab-b', folded: [toolTurn('b')] })
    act(() => list().props.onContentSizeChange(320, 1300))
    expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1300 })
  })

  it('repins after a keyboard-driven viewport layout only while following', async () => {
    vi.useFakeTimers()
    try {
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded })
      await act(async () => {
        vi.runOnlyPendingTimers()
      })
      scrollToEnd.mockClear()

      await update({ folded, keyboardInset: 320 })
      act(() => list().props.onLayout?.({ nativeEvent: { layout: { height: 400 } } }))

      expect(scrollToEnd).toHaveBeenCalledOnce()
      expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false })
      await act(async () => {
        vi.advanceTimersByTime(60)
      })
      expect(scrollToEnd).toHaveBeenCalledOnce()

      await scrollAwayFromTail()
      scrollToEnd.mockClear()
      await update({ folded, keyboardInset: 0 })
      act(() => list().props.onLayout?.({ nativeEvent: { layout: { height: 700 } } }))
      expect(scrollToEnd).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
