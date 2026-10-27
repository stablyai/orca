import { act } from 'react-test-renderer'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  installChatViewHooks,
  assistantTurn,
  hostType,
  list,
  pageScroller,
  platform,
  render,
  root,
  scrollEvent,
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
vi.mock('./native-chat/input/MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./native-chat/input/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: 'ChatPermission'
}))
vi.mock('./native-chat/input/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: 'ChatQuestion'
}))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./native-chat/composer/MobileNativeChatComposer', async () => {
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

  describe('on the page, whose list is anchored at its end', () => {
    const page = () => root().find((node) => hostType(node) === 'ScrollView')
    const jumpControl = () =>
      root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')

    beforeEach(() => {
      platform.OS = 'web'
      Object.assign(pageScroller, { scrollTop: 0, scrollHeight: 20_000, clientHeight: 500 })
    })

    afterEach(() => {
      platform.OS = 'ios'
    })

    function readerScrollsTo(y: number) {
      act(() => {
        pageScroller.scrollTop = y
        page().props.onScroll(scrollEvent(y, pageScroller.scrollHeight))
      })
    }

    it('stops following once the reader scrolls off the end, and follows again back at it', async () => {
      await render({ folded: [assistantTurn('a1', 'Latest')] })

      readerScrollsTo(-600)
      expect(jumpControl()).toHaveLength(1)
      readerScrollsTo(0)
      expect(jumpControl()).toHaveLength(0)

      readerScrollsTo(-600)
      act(() => jumpControl()[0]!.props.onPress())
      expect(pageScroller.scrollTop).toBe(0)
      act(() => page().props.onScroll(scrollEvent(0, pageScroller.scrollHeight)))
      expect(jumpControl()).toHaveLength(0)
    })

    it('opens another chat at its newest message, not where the reader left the last one', async () => {
      await render({ folded: [assistantTurn('a1', 'Chat A')] })
      readerScrollsTo(-600)

      await update({ folded: [assistantTurn('b1', 'Chat B')], sendSurfaceId: 'tab-b' })

      expect(pageScroller.scrollTop).toBe(0)
      expect(jumpControl()).toHaveLength(0)
    })

    it('asks for older history ahead of the top, and after a failure only the retry asks', async () => {
      const onLoadEarlier = vi.fn()
      const folded = [assistantTurn('a1', 'Latest')]
      await render({ folded, hasMore: true, onLoadEarlier })
      expect(onLoadEarlier).not.toHaveBeenCalled()

      readerScrollsTo(-15_000)
      expect(onLoadEarlier).toHaveBeenCalled()

      onLoadEarlier.mockClear()
      await update({ folded, hasMore: true, olderPages: 'loading', onLoadEarlier })
      readerScrollsTo(-19_500)
      await update({ folded, hasMore: true, olderPages: 'failed', onLoadEarlier })
      readerScrollsTo(-19_500)
      expect(onLoadEarlier).not.toHaveBeenCalled()

      const retry = root().find(
        (node) => hostType(node) === 'Pressable' && node.props.accessibilityRole === 'button'
      )
      act(() => retry.props.onPress())
      expect(onLoadEarlier).toHaveBeenCalledOnce()
    })

    it('fills a chat that opens shorter than its reach without a scroll', async () => {
      const onLoadEarlier = vi.fn()
      pageScroller.scrollHeight = 600
      await render({ folded: [assistantTurn('a1', 'Latest')], hasMore: true, onLoadEarlier })
      expect(onLoadEarlier).toHaveBeenCalled()
    })
  })
})
