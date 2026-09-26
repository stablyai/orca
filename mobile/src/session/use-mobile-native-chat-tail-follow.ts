import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import {
  planMobileChatPrependResize,
  type MobileChatPrependAnchor
} from './mobile-native-chat-prepend-anchor'

/** Distance from the bottom, in points, still treated as "at the tail". */
const AT_TAIL_SLOP = 80

function isAtTail(event: NativeScrollEvent): boolean {
  const { contentOffset, contentSize, layoutMeasurement } = event
  return contentSize.height - (contentOffset.y + layoutMeasurement.height) <= AT_TAIL_SLOP
}

export type MobileNativeChatTailFollow<TItem> = {
  /** Attach to the transcript list; the hook scrolls through this ref alone. */
  listRef: RefObject<FlatList<TItem> | null>
  /** Render flag for the jump-to-latest control. */
  showJumpToTail: boolean
  /** Passive maintenance: re-pin after the viewport resizes. */
  pinToTail: () => void
  /** Content-size maintenance using the list's authoritative measured height. */
  pinToTailAfterContentResize: (_width: number, height: number) => void
  /** Explicit jump — send, or the jump-to-latest control. Resumes following. */
  jumpToTail: () => void
  beginUserScroll: () => void
  endUserDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  beginMomentum: () => void
  endMomentum: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  /** Leave the tail deliberately, e.g. before prepending older history. */
  detachFromTail: () => void
  /**
   * Hold the visible row until an earlier page is actually inserted. Scrolls
   * during the request count; bottom-only growth does not.
   */
  holdVisibleContent: () => void
  recordScrollMetrics: (event: NativeScrollEvent) => void
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
 *  move intent; metrics only decide where a *released* gesture leaves us.
 */
export function useMobileNativeChatTailFollow<TItem>(args: {
  /** Guards `scrollToEnd` against an empty list. */
  hasItems: boolean
  /** Oldest transcript row. Also changes when the bounded window trims it. */
  historyHeadId: string | null
  /** Ids currently in the transcript, so a trim is not mistaken for a prepend. */
  messageIds: readonly string[]
  earlierPageLoading: boolean
  /** Chat surface identity. The view is reused across tab switches. */
  surfaceKey: string
}): MobileNativeChatTailFollow<TItem> {
  const { hasItems, historyHeadId, messageIds, earlierPageLoading, surfaceKey } = args
  const listRef = useRef<FlatList<TItem> | null>(null)
  const [following, setFollowingFlag] = useState(true)
  const [atTail, setAtTailFlag] = useState(true)
  // Event handlers read intent at event time, before a re-render lands.
  const followingRef = useRef(true)
  const atTailRef = useRef(true)
  const userScrollActiveRef = useRef(false)
  const userScrollSettleFrameRef = useRef<number | null>(null)
  const lastOffsetYRef = useRef(0)
  const lastHeightRef = useRef(0)
  const prependAnchorRef = useRef<MobileChatPrependAnchor | null>(null)
  const historyHeadIdRef = useRef(historyHeadId)
  historyHeadIdRef.current = historyHeadId
  const messageIdsRef = useRef(messageIds)
  messageIdsRef.current = messageIds
  const surfaceKeyRef = useRef(surfaceKey)
  if (surfaceKeyRef.current !== surfaceKey) {
    surfaceKeyRef.current = surfaceKey
    prependAnchorRef.current = null
  }
  const earlierPageLoadingRef = useRef(earlierPageLoading)
  const armedHeadId = prependAnchorRef.current?.historyHeadId
  const armedHeadRetained = armedHeadId != null && messageIds.includes(armedHeadId)
  if (
    earlierPageLoadingRef.current &&
    !earlierPageLoading &&
    prependAnchorRef.current &&
    (armedHeadId === historyHeadId || !armedHeadRetained)
  ) {
    // The page finished without inserting older rows, or the window trimmed the armed row.
    prependAnchorRef.current = null
  }
  earlierPageLoadingRef.current = earlierPageLoading

  // Single writer, so the event-time ref and the render flag cannot disagree.
  const setFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) {
      return
    }
    followingRef.current = next
    setFollowingFlag(next)
  }, [])

  const setAtTail = useCallback((next: boolean) => {
    if (atTailRef.current === next) {
      return
    }
    atTailRef.current = next
    setAtTailFlag(next)
  }, [])

  const pinToTail = useCallback(() => {
    if (!followingRef.current || !hasItems) {
      return
    }
    listRef.current?.scrollToEnd({ animated: false })
  }, [hasItems])

  const pinToTailAfterContentResize = useCallback(
    (_width: number, height: number) => {
      const hadAnchor = prependAnchorRef.current !== null
      const detached = !followingRef.current
      const plan = planMobileChatPrependResize({
        anchor: prependAnchorRef.current,
        following: followingRef.current,
        hasItems,
        height,
        offsetY: lastOffsetYRef.current,
        historyHeadId: historyHeadIdRef.current,
        armedHeadRetained:
          prependAnchorRef.current?.historyHeadId != null &&
          messageIdsRef.current.includes(prependAnchorRef.current.historyHeadId)
      })
      prependAnchorRef.current = plan.anchor
      if (plan.anchor) {
        lastHeightRef.current = plan.anchor.height
      }
      if (plan.scrollOffset === null) {
        return
      }
      if (hadAnchor && detached) {
        lastOffsetYRef.current = plan.scrollOffset
        lastHeightRef.current = height
      }
      listRef.current?.scrollToOffset({ animated: false, offset: plan.scrollOffset })
    },
    [hasItems]
  )

  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleFrameRef.current !== null) {
      cancelAnimationFrame(userScrollSettleFrameRef.current)
      userScrollSettleFrameRef.current = null
    }
  }, [])

  const recordScrollMetrics = useCallback(
    (event: NativeScrollEvent) => {
      lastOffsetYRef.current = event.contentOffset.y
      lastHeightRef.current = event.contentSize.height
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

  const detachFromTail = useCallback(() => {
    clearUserScrollSettle()
    userScrollActiveRef.current = false
    setAtTail(false)
    setFollowing(false)
  }, [clearUserScrollSettle, setAtTail, setFollowing])

  const holdVisibleContent = useCallback(() => {
    detachFromTail()
    // Why: FlatList keeps the numeric offset when rows are prepended, which
    // slides the visible page down by the inserted height.
    if (lastHeightRef.current > 0) {
      prependAnchorRef.current = {
        height: lastHeightRef.current,
        historyHeadId: historyHeadIdRef.current
      }
    }
  }, [detachFromTail])

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle])

  return {
    listRef,
    showJumpToTail: !following && !atTail,
    pinToTail,
    pinToTailAfterContentResize,
    jumpToTail,
    beginUserScroll,
    endUserDrag,
    beginMomentum,
    endMomentum,
    detachFromTail,
    holdVisibleContent,
    recordScrollMetrics
  }
}
