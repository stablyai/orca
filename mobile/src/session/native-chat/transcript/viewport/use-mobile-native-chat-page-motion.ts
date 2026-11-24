import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import {
  useMobileNativeChatPreviousAlign,
  type MobileNativeChatPreviousAlign
} from '../use-mobile-native-chat-previous-align'
import type { MobileNativeChatScrollNode } from './mobile-native-chat-reading-place'
import { scrollWritesStopMomentum } from './mobile-native-chat-scroll-motion'
import type { MobileNativeChatDrawn } from './use-mobile-native-chat-place-keeper'

type ListeningScroller = MobileNativeChatScrollNode & {
  addEventListener: (type: string, listener: () => void, options: AddEventListenerOptions) => void
  removeEventListener: (
    type: string,
    listener: () => void,
    options: AddEventListenerOptions
  ) => void
}

type Latest = {
  readonly current: {
    first: number
    keys: readonly string[]
    indexOf: ReadonlyMap<string, number>
    n: number
    rowKeys: { scope: string }
  }
}

type ScrollNode = {
  getScrollableNode?: () => unknown
  getInnerViewNode?: () => unknown
}

function domElementOf(node: unknown): Element | null {
  return typeof Element !== 'undefined' && node instanceof Element ? node : null
}

/** Page-list scroll, resize, and touch handling, including a previous-message jump. */
export function useMobileNativeChatPageMotion<S extends ListeningScroller>(args: {
  scroller: () => S | null
  write: (s: S, to: number) => void
  notePlace: (s: S) => void
  keepPlace: (s: S) => void
  latest: Latest
  setDrawn: (drawn: MobileNativeChatDrawn) => void
  keys: readonly string[]
  first: number
  resting: () => boolean
  drawAndFetch: (s: S) => void
  roots?: { restoreAll: () => void; observeWith: (observer: ResizeObserver | null) => void }
  scroll: RefObject<ScrollNode | null>
  hold: () => void
  unhold: () => void
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  onEndDistance: (fromEnd: number, byReader: boolean) => void
  isFollowing: () => boolean
  own: { current: number | null }
  readerScrolledAt: { current: number }
  touching: { current: boolean }
}): {
  align: MobileNativeChatPreviousAlign<S>
  scrolled: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
} {
  const {
    scroller,
    write,
    notePlace,
    keepPlace,
    latest,
    setDrawn,
    keys,
    first,
    resting,
    drawAndFetch,
    roots,
    scroll,
    hold,
    unhold,
    onScroll,
    onEndDistance,
    isFollowing,
    own,
    readerScrolledAt,
    touching
  } = args
  const align = useMobileNativeChatPreviousAlign({
    scroller,
    write,
    notePlace,
    latest,
    revealUndrawn: (index) => {
      const { keys: drawnKeys, n, rowKeys: keysNow } = latest.current
      const firstKey = drawnKeys[index]
      if (firstKey !== undefined) {
        setDrawn({ scope: keysNow.scope, firstKey, count: n - index })
      }
    }
  })

  const drawnHead = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    // Chromium keeps a touch scroll's offset from the top, so rows drawn or cut above would carry the reader with them; a write hands the scroll the end-anchored offset.
    // Skip place restoration while a previous-message jump is easing, or it pulls back to the old line.
    if (!align.aligning.current && keys[first] !== drawnHead.current) {
      drawnHead.current = keys[first]
      if (!resting() && !scrollWritesStopMomentum()) {
        const top = s.scrollTop
        s.scrollTop = top - 1
        write(s, top)
      }
    }
    if (!align.aligning.current) {
      keepPlace(s)
    }
    drawAndFetch(s)
    align.finishPendingAlign(s)
  })

  // Content and viewport resizes (e.g. the composer growing) bypass commits; restore nested scroll boxes first.
  useEffect(() => {
    const s = scroller()
    const viewport = domElementOf(scroll.current?.getScrollableNode?.())
    const content = domElementOf(scroll.current?.getInnerViewNode?.())
    if (!s || !viewport || !content || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      roots?.restoreAll()
      if (!align.aligning.current) {
        keepPlace(s)
      }
      drawAndFetch(s)
      align.finishPendingAlign(s)
    })
    observer.observe(viewport)
    observer.observe(content)
    roots?.observeWith(observer)
    return () => {
      roots?.observeWith(null)
      observer.disconnect()
    }
  }, [scroller, roots, keepPlace, drawAndFetch, scroll])

  useEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    // A release that hands over to a fling comes right after a scroll, which still counts.
    const down = () => {
      align.cancelAlign()
      touching.current = true
      hold()
    }
    const up = () => {
      touching.current = false
    }
    const options = { capture: true, passive: true }
    // Listen to both touch and pointer events because either can arrive first or be missing.
    const downs = ['touchstart', 'pointerdown']
    const ups = ['touchend', 'touchcancel', 'pointerup', 'pointercancel']
    downs.forEach((type) => s.addEventListener(type, down, options))
    ups.forEach((type) => s.addEventListener(type, up, options))
    return () => {
      downs.forEach((type) => s.removeEventListener(type, down, options))
      ups.forEach((type) => s.removeEventListener(type, up, options))
    }
  }, [align.cancelAlign, scroller, hold, touching])

  const scrolled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll(event)
      const s = scroller()
      if (!s) {
        return
      }
      // The jump's own frames and the momentum stop are not the reader taking over.
      const byReader =
        !align.aligning.current &&
        (own.current === null || Math.abs(s.scrollTop - own.current) >= 1)
      // RN Web repeats the last scroll event 100 ms after scrolling stops; keep our write so that repeat is ours too.
      if (byReader) {
        own.current = null
        readerScrolledAt.current = Date.now()
      }
      onEndDistance(Math.max(0, -s.scrollTop), byReader)
      if (isFollowing()) {
        unhold()
      } else if (byReader) {
        hold()
      }
      if (byReader) {
        notePlace(s)
      }
      drawAndFetch(s)
    },
    [
      onScroll,
      scroller,
      onEndDistance,
      isFollowing,
      hold,
      unhold,
      notePlace,
      drawAndFetch,
      align.aligning,
      own,
      readerScrolledAt
    ]
  )

  return { align, scrolled }
}
