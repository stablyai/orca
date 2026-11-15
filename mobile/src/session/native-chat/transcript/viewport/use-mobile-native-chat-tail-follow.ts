import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { forgetMobileNativeChatPlace } from './use-mobile-native-chat-place-keeper'

const AT_TAIL_SLOP = 80

/** The page's list is anchored at its end, so it reports the reader's distance from it itself. */
function listReportsGestures(): boolean {
  return Platform.OS !== 'web'
}

/** Holds the first visible row in place when rows above it change. The header is not a row. */
const ANCHOR_BELOW_HEADER = { minIndexForVisible: 1 } as const
const ANCHOR_AT_FIRST_ROW = { minIndexForVisible: 0 } as const

export function mobileNativeChatRowAnchor(hasHeader: boolean): { minIndexForVisible: number } {
  return hasHeader ? ANCHOR_BELOW_HEADER : ANCHOR_AT_FIRST_ROW
}

function distanceFromTail(event: NativeScrollEvent): number {
  const { contentOffset, contentSize, layoutMeasurement } = event
  return contentSize.height - (contentOffset.y + layoutMeasurement.height)
}

function isAtTail(event: NativeScrollEvent): boolean {
  return distanceFromTail(event) <= AT_TAIL_SLOP
}

export type MobileNativeChatListHandle = {
  scrollToOffset: (params: { animated: boolean; offset: number }) => void
  scrollToEnd: (params: { animated: boolean }) => void
  /** Puts the drawn row `key`'s start at the top of the view; only the page list draws row keys. */
  scrollRowToTop?: (key: string) => void
}

export type MobileNativeChatTailFollow = {
  listProps: { ref: (list: MobileNativeChatListHandle | null) => void }
  pageListProps: {
    ref: (list: MobileNativeChatListHandle | null) => void
    isFollowing: () => boolean
    onEndDistance: (fromEnd: number, byReader: boolean) => void
    onPlaceRestored: (scope: string) => void
  }
  showJumpToTail: boolean
  pinToTail: () => void
  pinToTailAfterContentResize: (_width: number, height: number) => void
  jumpToTail: () => void
  scrollRowToTop: (key: string) => void
  beginUserScroll: () => void
  endUserDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  beginMomentum: () => void
  endMomentum: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  scrollMayLoadEarlier: () => boolean
  recordScrollMetrics: (event: NativeScrollEvent) => void
}

// Use one non-animated follower: competing animated endpoints drift backward during streaming.
// Reader gestures and explicit jumps own follow intent; correction metrics must not change it.
export function useMobileNativeChatTailFollow(args: {
  hasItems: boolean
  /** The chat shown; another one opens following unless the list puts back where the reader left it. */
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
  const restoredScopeRef = useRef<string | null>(null)

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

  const attachList = useCallback((list: MobileNativeChatListHandle | null) => {
    listRef.current = list
  }, [])

  const pinToTail = useCallback(() => {
    if (followingRef.current && hasItems) {
      listRef.current?.scrollToEnd({ animated: false })
    }
  }, [hasItems])

  const pinToTailAfterContentResize = useCallback(
    (_width: number, height: number) => {
      if (followingRef.current && hasItems) {
        listRef.current?.scrollToOffset({ animated: false, offset: height })
      }
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
      if (listReportsGestures()) {
        setAtTail(isAtTail(event))
      }
    },
    [setAtTail]
  )

  // Detach even on one-point reader moves; programmatic corrections must not alter intent.
  const onEndDistance = useCallback(
    (fromEnd: number, byReader: boolean) => {
      setAtTail(fromEnd <= AT_TAIL_SLOP)
      if (byReader) {
        setFollowing(fromEnd <= 1)
      }
    },
    [setAtTail, setFollowing]
  )

  const jumpToTail = useCallback(() => {
    clearUserScrollSettle()
    userScrollActiveRef.current = false
    forgetMobileNativeChatPlace(scopeKeyRef.current)
    setAtTail(true)
    setFollowing(true)
    pinToTail()
  }, [clearUserScrollSettle, pinToTail, setAtTail, setFollowing])

  // Release the follow first, as desktop's scrollMessageToTop does, so streaming cannot pull the row away.
  const scrollRowToTop = useCallback(
    (key: string) => {
      clearUserScrollSettle()
      userScrollActiveRef.current = false
      setFollowing(false)
      listRef.current?.scrollRowToTop?.(key)
    },
    [clearUserScrollSettle, setFollowing]
  )

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

  // The list commits before this view's chat-change effect, so the scope says which chat it restored.
  const onPlaceRestored = useCallback(
    (scope: string) => {
      restoredScopeRef.current = scope
      clearUserScrollSettle()
      userScrollActiveRef.current = false
      setFollowing(false)
    },
    [clearUserScrollSettle, setFollowing]
  )

  // Reset before paint on chat changes so a mounted view cannot expose the previous reader position.
  useLayoutEffect(() => {
    if (scopeKeyRef.current === scopeKey) {
      return
    }
    scopeKeyRef.current = scopeKey
    const restored = restoredScopeRef.current === scopeKey
    restoredScopeRef.current = null
    if (!restored) {
      jumpToTail()
    }
  }, [scopeKey, jumpToTail])

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle])

  return {
    listProps: { ref: attachList },
    pageListProps: { ref: attachList, isFollowing, onEndDistance, onPlaceRestored },
    showJumpToTail: !following && !atTail,
    pinToTail,
    pinToTailAfterContentResize,
    jumpToTail,
    scrollRowToTop,
    beginUserScroll,
    endUserDrag,
    beginMomentum,
    endMomentum,
    scrollMayLoadEarlier,
    recordScrollMetrics
  }
}
