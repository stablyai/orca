import { act } from 'react-test-renderer'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  installChatViewHooks,
  assistantTurn,
  list,
  pageScroller,
  platform,
  render,
  root,
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
vi.mock('./MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: history paging and anchoring', () => {
  installChatViewHooks()

  it('stops tail-follow before loading earlier history can resize the list', async () => {
    const folded = [assistantTurn('a1', 'History')]
    const onLoadEarlier = vi.fn()
    await render({ folded, hasMore: true, onLoadEarlier })
    scrollToEnd.mockClear()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll({
        nativeEvent: {
          contentOffset: { y: 40 },
          contentSize: { height: 1_200 },
          layoutMeasurement: { height: 500 }
        }
      })
      list().props.onContentSizeChange(320, 950)
    })

    expect(onLoadEarlier).toHaveBeenCalledOnce()
    expect(scrollToEnd).not.toHaveBeenCalled()
    expect(scrollToOffset).not.toHaveBeenCalled()
  })

  it('resumes following when the drag that paged in history ends at the tail', async () => {
    vi.useFakeTimers()
    try {
      // A chat shorter than the screen: its top and its tail are the same place.
      const shortChat = {
        contentOffset: { y: 0 },
        contentSize: { height: 400 },
        layoutMeasurement: { height: 500 }
      }
      const folded = [assistantTurn('a1', 'Short history')]
      const onLoadEarlier = vi.fn()
      await render({ folded, hasMore: true, onLoadEarlier })

      act(() => {
        list().props.onScrollBeginDrag?.({})
        list().props.onScroll({ nativeEvent: shortChat })
        list().props.onScrollEndDrag?.({ nativeEvent: shortChat })
      })
      await act(async () => {
        vi.advanceTimersByTime(200)
      })
      act(() => list().props.onContentSizeChange(320, 950))

      expect(onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 950 })
      expect(
        root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pages in history only from a scroll the reader made', async () => {
    const onLoadEarlier = vi.fn()
    await render({ folded: [assistantTurn('a1', 'Latest')], hasMore: true, onLoadEarlier })
    const nearTop = {
      nativeEvent: {
        contentOffset: { y: 40 },
        contentSize: { height: 520 },
        layoutMeasurement: { height: 500 }
      }
    }

    // The tail pin of a chat barely taller than the screen reports an offset near the top too.
    act(() => list().props.onScroll(nearTop))
    expect(onLoadEarlier).not.toHaveBeenCalled()

    act(() => {
      list().props.onScrollBeginDrag?.({})
      list().props.onScroll(nearTop)
    })
    expect(onLoadEarlier).toHaveBeenCalledOnce()
  })

  it('anchors the first visible row, which the header above it is not', async () => {
    const folded = [assistantTurn('a1', 'History')]
    await render({ folded, hasMore: true })
    expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 })

    await update({ folded, hasMore: false })
    expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 })
  })

  describe('on the page, where the list reports no drag or momentum', () => {
    beforeEach(() => {
      platform.OS = 'web'
    })

    afterEach(() => {
      platform.OS = 'ios'
    })

    function scrolledTo(y: number, contentHeight: number) {
      return {
        nativeEvent: {
          contentOffset: { y },
          contentSize: { height: contentHeight },
          layoutMeasurement: { height: 500 }
        }
      }
    }

    it('stops following when the reader scrolls up, and resumes at the end', async () => {
      await render({ folded: [assistantTurn('a1', 'Latest')] })
      act(() => {
        list().props.onContentSizeChange(320, 1_000)
        list().props.onScroll(scrolledTo(500, 1_000))
      })
      scrollToOffset.mockClear()

      // No drag event arrives on the page: the move up is all there is to go on.
      act(() => {
        list().props.onScroll(scrolledTo(300, 1_000))
        list().props.onContentSizeChange(320, 1_200)
      })
      expect(scrollToOffset).not.toHaveBeenCalled()
      expect(
        root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(1)

      act(() => {
        list().props.onScroll(scrolledTo(700, 1_200))
        list().props.onContentSizeChange(320, 1_400)
      })
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_400 })
    })

    it('does not take its own pin, landing short of a grown end, for the reader', async () => {
      await render({ folded: [assistantTurn('a1', 'Latest')] })
      act(() => {
        list().props.onContentSizeChange(320, 1_000)
        list().props.onScroll(scrolledTo(500, 1_000))
      })
      scrollToOffset.mockClear()

      // The pin reached the end it was sent to; the reply had grown 400 past it by then.
      act(() => {
        list().props.onScroll(scrolledTo(700, 1_600))
        list().props.onContentSizeChange(320, 1_600)
      })

      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 1_600 })
    })

    it("opens another chat at its measured end, not the last chat's", async () => {
      await render({ folded: [assistantTurn('a1', 'Chat A')] })
      act(() => list().props.onContentSizeChange(320, 1_000))
      pageScroller.scrollHeight = 2_500
      scrollToEnd.mockClear()

      await update({ folded: [assistantTurn('b1', 'Chat B')], sendSurfaceId: 'tab-b' })

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 2_500 })
    })

    it('pages in history when the reader scrolls up to the top, not when a pin passes it', async () => {
      const onLoadEarlier = vi.fn()
      await render({ folded: [assistantTurn('a1', 'Latest')], hasMore: true, onLoadEarlier })

      act(() => list().props.onScroll(scrolledTo(40, 540)))
      expect(onLoadEarlier).not.toHaveBeenCalled()

      act(() => list().props.onScroll(scrolledTo(10, 540)))
      expect(onLoadEarlier).toHaveBeenCalledOnce()
    })
  })
})
