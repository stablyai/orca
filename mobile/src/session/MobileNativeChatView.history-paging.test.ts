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
    const observers = new Set<(entries: unknown[]) => void>()
    // The browser's resize step, before paint; RN Web's size report comes a task later.
    const resized = () => act(() => observers.forEach((deliver) => deliver([])))
    const page = () => root().find((node) => hostType(node) === 'ScrollView')
    const loadEarlier = () =>
      root().find(
        (node) =>
          hostType(node) === 'Pressable' &&
          node.findAll((text) => text.props.children === 'Load earlier messages').length > 0
      )

    beforeEach(() => {
      platform.OS = 'web'
      scrollToOffset.mockImplementation((to: { offset: number }) => {
        pageScroller.scrollTop = to.offset
      })
      observers.clear()
      vi.stubGlobal('ResizeObserver', function (deliver: (entries: unknown[]) => void) {
        return {
          observe: () => observers.add(deliver),
          unobserve: () => {},
          disconnect: () => observers.delete(deliver)
        }
      })
    })

    afterEach(() => {
      platform.OS = 'ios'
    })

    function scrolledTo(y: number, contentHeight: number) {
      Object.assign(pageScroller, { scrollTop: y, scrollHeight: contentHeight })
      return scrollEvent(y, contentHeight)
    }

    // RN Web's report and the scroller's own event, for one position.
    function scrollTo(y: number, contentHeight: number) {
      act(() => {
        page().props.onScroll(scrolledTo(y, contentHeight))
        pageScroller.scroll()
      })
    }

    it('holds a following reader at the live end through growth and a smaller viewport', async () => {
      const latest = [assistantTurn('a1', 'Latest')]
      const landed = [assistantTurn('a0', 'Older'), ...latest]
      const onLoadEarlier = vi.fn()
      await render({ folded: latest, hasMore: true, onLoadEarlier })
      scrollTo(500, 1_000)

      // Older rows land; the observer pins before paint.
      act(() => loadEarlier().props.onPress())
      await update({ folded: landed, hasMore: true, onLoadEarlier })
      pageScroller.scrollHeight = 5_000
      resized()
      expect(onLoadEarlier).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenCalledOnce()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 4_500 })

      // The pin's own move, short of a reply that grew meanwhile, is not the reader's.
      scrollTo(4_500, 5_400)
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 4_900 })

      // The browser clamping the scroll to a shorter end is layout's, not the reader's: it still
      // follows, and the next growth pins.
      scrollTo(3_500, 4_000)
      pageScroller.scrollHeight = 5_400
      resized()
      expect(scrollToOffset).toHaveBeenCalledTimes(3)
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 4_900 })
      scrollTo(4_900, 5_400)

      // The reader's wheel moves it up: it leaves the end.
      pageScroller.input('wheel')
      scrollTo(3_000, 5_400)
      pageScroller.scrollHeight = 6_000
      resized()
      expect(scrollToOffset).toHaveBeenCalledTimes(3)
      expect(
        root().findAll((node) => node.props.accessibilityLabel === 'Scroll to latest')
      ).toHaveLength(1)

      // Back at the end it follows again, and a smaller viewport pins to the live end.
      scrollTo(5_500, 6_000)
      pageScroller.scrollHeight = 6_400
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 5_900 })
      pageScroller.clientHeight = 300
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 6_100 })
      expect(scrollToEnd).not.toHaveBeenCalled()
    })

    it('resumes an expired downward fling near the end, preserving small upward detachment', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
      vi.stubGlobal('navigator', { userAgent: 'Chrome' })
      const browserHolds = () => pageScroller.style.overflowAnchor === 'auto'
      await render({ folded: ['a1', 'a2', 'a3'].map((id) => assistantTurn(id, id)) })
      scrollTo(500, 1_000)
      resized()
      pageScroller.input('wheel')
      scrollTo(497, 1_000)
      // Expired input and geometry away from the end cannot detach or attach by themselves.
      now.mockReturnValue(11_100)
      pageScroller.scrollHeight = 1_200
      resized()
      expect(browserHolds()).toBe(true)
      scrollTo(632, 1_200)
      expect(browserHolds()).toBe(false)
      pageScroller.scrollHeight = 1_300
      resized()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 800 })
      scrollTo(800, 1_300) // Deliver the pin's own scroll before the next reader movement.
      // The first upward movement can arrive in resize before its scroll event.
      pageScroller.input('wheel')
      pageScroller.scrollTop = 780
      resized()
      expect(browserHolds()).toBe(true)
      scrollTo(799, 1_300)
      expect(browserHolds()).toBe(false)
      now.mockRestore()
    })

    it('detaches a following reader who drags up slowly, one pixel per scroll event', async () => {
      // iOS, where it happened: WebKit has no anchoring, so every move that isn't a clamp is the reader's.
      vi.stubGlobal('navigator', {
        userAgent:
          'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1'
      })
      await render({ folded: ['a1', 'a2', 'a3'].map((id) => assistantTurn(id, id)) })
      scrollTo(500, 1_000)
      resized()
      const pins = scrollToOffset.mock.calls.length
      // Each step's frame reconciles what it drew, as the browser's resize step does.
      for (let top = 499; top >= 470; top -= 1) {
        scrollTo(top, 1_000)
        resized()
      }
      // A reply lands: the reader who dragged 30px up is not pulled back to the end.
      pageScroller.scrollHeight = 1_063
      resized()
      expect(scrollToOffset.mock.calls.length).toBe(pins)
    })

    it('resumes following after a slow one-pixel return to the end on Safari', async () => {
      vi.stubGlobal('navigator', {
        userAgent:
          'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1'
      })
      await render({ folded: ['a1', 'a2', 'a3'].map((id) => assistantTurn(id, id)) })
      scrollTo(500, 1_000)
      resized()
      // Deliver the initial pin's own scroll before the reader moves.
      scrollTo(500, 1_000)
      scrollTo(470, 1_000)
      resized()
      const pins = scrollToOffset.mock.calls.length

      for (let top = 471; top <= 500; top += 1) {
        scrollTo(top, 1_000)
        resized()
        expect(scrollToOffset.mock.calls.length).toBe(pins)
      }

      pageScroller.scrollHeight = 1_063
      resized()
      expect(scrollToOffset.mock.calls.length).toBe(pins + 1)
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 563 })
      expect(pageScroller.scrollTop).toBe(563)
    })

    it.each([false, true])(
      'leaves a parked reader parked when a collapse below them clamps the page onto its end (finger down: %s)',
      async (fingerDown) => {
        await render({ folded: ['a1', 'a2', 'a3'].map((id) => assistantTurn(id, id)) })
        scrollTo(500, 1_000)
        resized()
        // Parked 29 px short of the end by the reader's own wheel.
        pageScroller.input('wheel')
        scrollTo(471, 1_000)
        const pins = scrollToOffset.mock.calls.length

        // A run below collapses: the browser clamps onto the shorter end, possibly under the tap.
        if (fingerDown) {
          pageScroller.input('touchstart')
        }
        scrollTo(200, 700)
        resized()
        if (fingerDown) {
          pageScroller.input('touchend')
        }
        // A reply lands. Main leaves the reader where the clamp put them; so does the page.
        pageScroller.scrollHeight = 763
        resized()
        expect(scrollToOffset.mock.calls.length).toBe(pins)
      }
    )

    it("opens another chat at its live end, not the last chat's", async () => {
      await render({ folded: [assistantTurn('a1', 'Chat A')] })
      scrollTo(500, 1_000)
      // The next chat is taller; its size report hasn't come yet.
      pageScroller.scrollHeight = 2_500
      scrollToOffset.mockClear()

      await update({ folded: [assistantTurn('b1', 'Chat B')], sendSurfaceId: 'tab-b' })

      expect(scrollToEnd).not.toHaveBeenCalled()
      expect(scrollToOffset).toHaveBeenLastCalledWith({ animated: false, offset: 2_000 })
    })

    it('loads older history from the Load earlier control, not from reaching the top', async () => {
      const onLoadEarlier = vi.fn()
      await render({ folded: [assistantTurn('a1', 'Latest')], hasMore: true, onLoadEarlier })

      // Down to the top and into iOS's bounce past it.
      act(() => {
        page().props.onScroll(scrolledTo(40, 540))
        page().props.onScroll(scrolledTo(-15, 540))
      })
      expect(onLoadEarlier).not.toHaveBeenCalled()

      act(() => loadEarlier().props.onPress())
      expect(onLoadEarlier).toHaveBeenCalledOnce()
    })
  })
})
