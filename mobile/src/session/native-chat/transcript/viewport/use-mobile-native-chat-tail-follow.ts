import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Platform, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import {
  saveMobileNativeChatPlace,
  savedMobileNativeChatPlace,
  type MobileNativeChatPlace,
  type MobileNativeChatRestore
} from './mobile-native-chat-saved-places'

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
  /** The reader's top row and how far into it the view starts; undefined with no row drawn. */
  readPlace: () => MobileNativeChatPlace | undefined
  restorePlace: (place: MobileNativeChatPlace) => MobileNativeChatRestore
}

export type MobileNativeChatTailFollow = {
  listProps: { ref: (list: MobileNativeChatListHandle | null) => void }
  pageListProps: {
    ref: (list: MobileNativeChatListHandle | null) => void
    isFollowing: () => boolean
    onEndDistance: (fromEnd: number, byReader: boolean) => void
    /** Each commit of the list's rows: a restore waiting for its row tries again. */
    onDrawn: () => void
  }
  showJumpToTail: boolean
  pinToTail: () => void
  pinToTailAfterContentResize: (_width: number, height: number) => void
  jumpToTail: () => void
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
  /** The chat shown; another one opens following, whatever the reader did here. */
  scopeKey: string
}): MobileNativeChatTailFollow {
  const { hasItems, scopeKey } = args
  const listRef = useRef<MobileNativeChatListHandle | null>(null)
  // A chat the reader left away from its tail reopens there, even in a remounted view.
  const [opened] = useState(() => savedMobileNativeChatPlace(scopeKey) ?? null)
  const [following, setFollowingFlag] = useState(opened === null)
  const [atTail, setAtTailFlag] = useState(opened === null)
  // Event handlers read intent at event time, before a re-render lands.
  const followingRef = useRef(opened === null)
  const atTailRef = useRef(opened === null)
  const restoreRef = useRef<MobileNativeChatPlace | null>(opened)
  const retryRestore = useRef(() => {})
  const userScrollActiveRef = useRef(false)
  const userScrollSettleFrameRef = useRef<number | null>(null)
  const scopeKeyRef = useRef(scopeKey)

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

  // Kept per chat, so switching back to it lands where the reader left it.
  const rememberPlace = useCallback(() => {
    const scope = scopeKeyRef.current
    if (followingRef.current) {
      saveMobileNativeChatPlace(scope, null)
      return
    }
    const place = listRef.current?.readPlace()
    if (place) {
      saveMobileNativeChatPlace(scope, place)
    }
  }, [])

  const pinToTail = useCallback(() => {
    if (restoreRef.current) {
      retryRestore.current()
      return
    }
    if (followingRef.current && hasItems) {
      listRef.current?.scrollToEnd({ animated: false })
    }
  }, [hasItems])

  const pinToTailAfterContentResize = useCallback(
    (_width: number, height: number) => {
      if (restoreRef.current) {
        retryRestore.current()
        return
      }
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
        restoreRef.current = null
        setFollowing(fromEnd <= 1)
        rememberPlace()
      }
    },
    [rememberPlace, setAtTail, setFollowing]
  )

  const jumpToTail = useCallback(() => {
    clearUserScrollSettle()
    userScrollActiveRef.current = false
    restoreRef.current = null
    setAtTail(true)
    setFollowing(true)
    rememberPlace()
    pinToTail()
  }, [clearUserScrollSettle, pinToTail, rememberPlace, setAtTail, setFollowing])

  // A restore waits until its row is drawn; a row no longer in the chat sends the reader to the tail.
  const tryRestore = useCallback(() => {
    const place = restoreRef.current
    const result = place ? listRef.current?.restorePlace(place) : undefined
    if (result === undefined || result === 'pending') {
      return
    }
    restoreRef.current = null
    if (result === 'missing') {
      jumpToTail()
    }
  }, [jumpToTail])

  const openChat = useCallback(
    (scope: string) => {
      const place = savedMobileNativeChatPlace(scope)
      if (!place) {
        jumpToTail()
        return
      }
      clearUserScrollSettle()
      userScrollActiveRef.current = false
      setAtTail(false)
      setFollowing(false)
      restoreRef.current = place
      tryRestore()
    },
    [clearUserScrollSettle, jumpToTail, setAtTail, setFollowing, tryRestore]
  )

  const beginUserScroll = useCallback(() => {
    clearUserScrollSettle()
    userScrollActiveRef.current = true
    restoreRef.current = null
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
      rememberPlace()
      if (finishedAtTail) {
        pinToTail()
      }
    },
    [clearUserScrollSettle, pinToTail, rememberPlace, setAtTail, setFollowing]
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

  useLayoutEffect(() => {
    retryRestore.current = tryRestore
  })

  // Before paint on chat changes, so a mounted view never shows the previous chat's position.
  useLayoutEffect(() => {
    if (scopeKeyRef.current === scopeKey) {
      tryRestore()
      return
    }
    scopeKeyRef.current = scopeKey
    openChat(scopeKey)
  }, [scopeKey, openChat, tryRestore])

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle])

  return {
    listProps: { ref: attachList },
    pageListProps: { ref: attachList, isFollowing, onEndDistance, onDrawn: tryRestore },
    showJumpToTail: !following && !atTail,
    pinToTail,
    pinToTailAfterContentResize,
    jumpToTail,
    beginUserScroll,
    endUserDrag,
    beginMomentum,
    endMomentum,
    scrollMayLoadEarlier,
    recordScrollMetrics
  }
}
