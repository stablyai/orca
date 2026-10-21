import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import type { MobileNativeChatScrollNode } from './MobileNativeChatScrollHold'
import type { MobileNativeChatPageObservation } from './mobile-native-chat-page-motion'

/** Distance from the bottom, in points, still treated as "at the tail". */
const AT_TAIL_SLOP = 80

/** RN Web's ScrollView reports no drag or momentum, so on the page the offsets themselves have to
 *  say what the reader did. It ignores `maintainVisibleContentPosition` too. */
function listReportsGestures(): boolean {
  return Platform.OS !== 'web'
}

/** Offset change, in points, below which the page treats the view as not having moved. */
const PAGE_MOVE_SLOP = 1

/** Holds the first visible row in place when rows above it change. The header is not a row. */
const ANCHOR_BELOW_HEADER = { minIndexForVisible: 1 } as const
const ANCHOR_AT_FIRST_ROW = { minIndexForVisible: 0 } as const

export function mobileNativeChatRowAnchor(hasHeader: boolean): { minIndexForVisible: number } {
  return hasHeader ? ANCHOR_BELOW_HEADER : ANCHOR_AT_FIRST_ROW
}

/** The list's scrollable node on the page, as RN Web's ScrollView decorates it. */
type PageScroller = Element & MobileNativeChatScrollNode & { getInnerViewNode: () => Element }

/** RN Web reports content size a task after layout, so a frame can paint between growth and a pin
 *  driven by that report. An observer on the scroller and its content runs before that paint. */
function observePageResize(
  scroller: PageScroller | null | undefined,
  onResize: (entries: readonly ResizeObserverEntry[]) => void
): ResizeObserver | null {
  if (!scroller || typeof ResizeObserver === 'undefined') {
    return null
  }
  const observer = new ResizeObserver(onResize)
  observer.observe(scroller)
  observer.observe(scroller.getInnerViewNode())
  return observer
}

function distanceFromTail(event: NativeScrollEvent): number {
  const { contentOffset, contentSize, layoutMeasurement } = event
  return contentSize.height - (contentOffset.y + layoutMeasurement.height)
}

function isAtTail(event: NativeScrollEvent): boolean {
  return distanceFromTail(event) <= AT_TAIL_SLOP
}

/** What the owner and the place-hold use of a transcript list: native's FlatList, or the page's. */
export type MobileNativeChatListHandle = {
  getScrollableNode: () => PageScroller | null | undefined
  scrollToOffset: (params: { animated: boolean; offset: number }) => void
  scrollToEnd: (params: { animated: boolean }) => void
  /** Page only: each resize, with the observer's entries; runs the end `pin` once it has counted a
   *  move of the reader's no scroll event reported yet. */
  afterResize?: (entries: readonly ResizeObserverEntry[], pin: () => void) => void
  /** Page only: the list's rows join the one observer, so each reports its own height. */
  observeWith?: (observer: ResizeObserver | null) => void
  /** Page only: the place-hold's correction, written while the reader moves only for a regroup. */
  keepInPlace?: (drift: number, regrouped: boolean) => void
  /** Page only: resolves once the reader stops moving the list, or the list goes away. */
  settled?: () => Promise<void>
  /** Page only: each classified move, before any resize correction or end pin. */
  watchMotion?: (fn: ((observation: MobileNativeChatPageObservation) => void) | null) => void
  /** Page only: following changed, which decides whether the browser's anchoring may move it. */
  syncAnchoring?: () => void
  /** Page only: the place-hold takes the scroll from the browser's anchoring for its correction. */
  holdPlace?: (on: boolean) => void
}

export type MobileNativeChatTailFollow = {
  /** Spread on the native list. `ref`: the hook scrolls through it alone. */
  listProps: { ref: (list: MobileNativeChatListHandle | null) => () => void }
  /** Spread on the page list: the same `ref`, which also watches the list resize. */
  pageListProps: {
    ref: (list: MobileNativeChatListHandle | null) => () => void
    endAnchored: boolean
    isFollowing: () => boolean
    pin: () => void
  }
  /** Render flag for the jump-to-latest control. */
  showJumpToTail: boolean
  /** Passive maintenance: re-pin after the viewport resizes. */
  pinToTail: () => void
  /** Content-size maintenance: native uses the measured height, the page its live end. */
  pinToTailAfterContentResize: (_width: number, height: number) => void
  /** Explicit jump — send, or the jump-to-latest control. Resumes following. */
  jumpToTail: () => void
  beginUserScroll: () => void
  endUserDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  beginMomentum: () => void
  endMomentum: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  /** Whether a scroll near the top may page in older history: only a native list's own drag. The
   *  page loads it only from the "Load earlier" control, since a page landing in iOS's top bounce
   *  gets the place-hold's write while WebKit owns the scroll, and the list stops scrolling. */
  scrollMayLoadEarlier: () => boolean
  recordScrollMetrics: (event: NativeScrollEvent) => void
  /** Page only: an older page waits for it, so it never lands under a reader who is scrolling. */
  pageSettled: (() => Promise<void>) | undefined
  /** Read at commit by the page's place-hold: the list, and whether the reader follows the end. */
  placeHold: { listRef: RefObject<MobileNativeChatListHandle | null>; isFollowing: () => boolean }
}

/** Sole owner of transcript scroll position.
 *
 *  Streaming used to have several tail-followers at once: a delayed *animated*
 *  `scrollToEnd` alongside an immediate non-animated one on content growth. The
 *  animated command eases toward the endpoint measured when it started, so while
 *  tokens kept arriving it ran backwards until the content-size pin yanked it
 *  forward — the visible drift-then-snap. One owner, never animated, removes it.
 *
 *  Intent (`following`) is kept separate from geometry (at-tail): a programmatic
 *  scroll reports metrics like any other, so letting metrics decide intent let
 *  the view argue with itself. Only the user's own gestures and explicit jumps
 *  move native intent; metrics decide where a *released* gesture leaves us. On
 *  the page, a move toward the end resumes following; only reader input detaches it.
 */
export function useMobileNativeChatTailFollow(args: {
  /** Guards `scrollToEnd` against an empty list. */
  hasItems: boolean
  /** The chat shown; another one opens following, whatever the reader did here. */
  scopeKey: string
}): MobileNativeChatTailFollow {
  const { hasItems, scopeKey } = args
  const listRef = useRef<MobileNativeChatListHandle | null>(null)
  const [following, setFollowingFlag] = useState(true)
  const [atTail, setAtTailFlag] = useState(true)
  // Event handlers read intent at event time, before a re-render lands.
  const followingRef = useRef(true)
  const atTailRef = useRef(true)
  const userScrollActiveRef = useRef(false)
  const userScrollSettleFrameRef = useRef<number | null>(null)
  const scopeKeyRef = useRef(scopeKey)

  // Single writer, so the event-time ref and the render flag cannot disagree.
  const setFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) {
      return
    }
    followingRef.current = next
    // Before any write or commit: the browser's anchoring and the end pin never both hold the place.
    listRef.current?.syncAnchoring?.()
    setFollowingFlag(next)
  }, [])

  const setAtTail = useCallback((next: boolean) => {
    if (atTailRef.current === next) {
      return
    }
    atTailRef.current = next
    setAtTailFlag(next)
  }, [])

  // Live geometry: a size report arrives late and can name an end the view has already left.
  // Not `scrollToEnd`: its estimate can land short, and the page reads a move up as the reader's.
  const pinPageToEnd = useCallback(() => {
    const scroller = listRef.current?.getScrollableNode()
    if (!followingRef.current || !scroller) {
      return
    }
    const end = scroller.scrollHeight - scroller.clientHeight
    // Already there, or iOS bouncing past an end: a write then lands while WebKit owns the scroll.
    if (scroller.scrollTop < 0 || scroller.scrollTop >= end - PAGE_MOVE_SLOP) {
      return
    }
    listRef.current?.scrollToOffset({ animated: false, offset: end })
  }, [])

  const attachList = useCallback(
    (list: MobileNativeChatListHandle | null) => {
      listRef.current = list
      const page = !listReportsGestures()
      // Following comes only from classified motion: a resize can land a parked reader on a shorter
      // end (a collapse below them), and that clamp is layout's, not the reader asking to follow.
      const observer = page
        ? observePageResize(list?.getScrollableNode(), (entries) =>
            list?.afterResize ? list.afterResize(entries, pinPageToEnd) : pinPageToEnd()
          )
        : null
      list?.observeWith?.(observer)
      // Only a move toward the end attaches: a clamp onto a shorter end moves up, even one that
      // lands under the reader's finger (a tap on a collapse below them).
      list?.watchMotion?.(({ by, moved, fromEnd }) => {
        if (followingRef.current) {
          // Any upward move of the reader's that leaves the end detaches: a slow drag reports many
          // 1px moves, and none of them alone is past a per-event threshold.
          if (by === 'reader' && moved < 0 && fromEnd > PAGE_MOVE_SLOP) {
            setFollowing(false)
          }
        } else if (
          (by === 'reader' && moved > 0 && fromEnd <= PAGE_MOVE_SLOP) ||
          (by !== 'own' && moved > PAGE_MOVE_SLOP && fromEnd <= AT_TAIL_SLOP)
        ) {
          setFollowing(true)
        }
      })
      return () => {
        list?.watchMotion?.(null)
        list?.observeWith?.(null)
        observer?.disconnect()
        listRef.current = null
      }
    },
    [pinPageToEnd, setFollowing]
  )

  const pinToTail = useCallback(() => {
    if (!listReportsGestures()) {
      pinPageToEnd()
    } else if (followingRef.current && hasItems) {
      listRef.current?.scrollToEnd({ animated: false })
    }
  }, [hasItems, pinPageToEnd])

  const pinToTailAfterContentResize = useCallback(
    (_width: number, height: number) => {
      if (!listReportsGestures()) {
        pinPageToEnd()
      } else if (followingRef.current && hasItems) {
        listRef.current?.scrollToOffset({ animated: false, offset: height })
      }
    },
    [hasItems, pinPageToEnd]
  )

  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleFrameRef.current !== null) {
      cancelAnimationFrame(userScrollSettleFrameRef.current)
      userScrollSettleFrameRef.current = null
    }
  }, [])

  const recordScrollMetrics = useCallback(
    (event: NativeScrollEvent) => {
      setAtTail(isAtTail(event))
    },
    [setAtTail]
  )

  const jumpToTail = useCallback(() => {
    clearUserScrollSettle()
    userScrollActiveRef.current = false
    setAtTail(true)
    setFollowing(true)
    pinToTail()
  }, [clearUserScrollSettle, pinToTail, setAtTail, setFollowing])

  const beginUserScroll = useCallback(() => {
    clearUserScrollSettle()
    userScrollActiveRef.current = true
    setFollowing(false)
  }, [clearUserScrollSettle, setFollowing])

  const finishUserScroll = useCallback(
    (finishedAtTail: boolean) => {
      if (!userScrollActiveRef.current) {
        return
      }
      clearUserScrollSettle()
      userScrollActiveRef.current = false
      setAtTail(finishedAtTail)
      setFollowing(finishedAtTail)
      if (finishedAtTail) {
        pinToTail()
      }
    },
    [clearUserScrollSettle, pinToTail, setAtTail, setFollowing]
  )

  const endUserDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!userScrollActiveRef.current) {
        return
      }
      clearUserScrollSettle()
      const releasedAtTail = isAtTail(event.nativeEvent)
      userScrollSettleFrameRef.current = requestAnimationFrame(() => {
        userScrollSettleFrameRef.current = null
        finishUserScroll(releasedAtTail)
      })
    },
    [clearUserScrollSettle, finishUserScroll]
  )

  const beginMomentum = useCallback(() => {
    if (userScrollActiveRef.current) {
      clearUserScrollSettle()
    }
  }, [clearUserScrollSettle])

  const endMomentum = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) =>
      finishUserScroll(isAtTail(event.nativeEvent)),
    [finishUserScroll]
  )

  const scrollMayLoadEarlier = useCallback(
    () => listReportsGestures() && userScrollActiveRef.current,
    []
  )

  const isFollowing = useCallback(() => followingRef.current, [])
  const pageSettled = useCallback(() => listRef.current?.settled?.() ?? Promise.resolve(), [])

  // The view stays mounted across chats: before paint, so the next one never shows where the reader
  // left the last.
  useLayoutEffect(() => {
    if (scopeKeyRef.current === scopeKey) {
      return
    }
    scopeKeyRef.current = scopeKey
    jumpToTail()
  }, [scopeKey, jumpToTail])

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle])

  return {
    listProps: { ref: attachList },
    pageListProps: { ref: attachList, endAnchored: following, isFollowing, pin: pinPageToEnd },
    showJumpToTail: !following && !atTail,
    pinToTail,
    pinToTailAfterContentResize,
    jumpToTail,
    beginUserScroll,
    endUserDrag,
    beginMomentum,
    endMomentum,
    scrollMayLoadEarlier,
    recordScrollMetrics,
    pageSettled: listReportsGestures() ? undefined : pageSettled,
    placeHold: { listRef, isFollowing }
  }
}
