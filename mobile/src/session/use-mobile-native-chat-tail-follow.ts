import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { nativeChatDistanceFromBottom } from '../../../src/shared/native-chat-scroll-geometry'
import type { MobileNativeChatLoadEarlier } from './use-mobile-native-chat-session'

const BOTTOM_THRESHOLD = 80
const TAIL_FOLLOW_DELAY_MS = 60

type HistoryRequest = {
  restoreFollowing: boolean
  triggeringGesture: number | null
  userIntent: boolean | null
}

type MobileNativeChatTailFollow = {
  atBottom: boolean
  detachTail: () => void
  followTail: (animated: boolean) => void
  followTailAfterLayout: () => void
  onContentSizeChange: (height: number) => void
  onMomentumScrollBegin: () => void
  onMomentumScrollEnd: () => void
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  onScrollBeginDrag: () => void
  onScrollEndDrag: () => void
  requestHistory: (loadEarlier: MobileNativeChatLoadEarlier) => boolean
  requestHistoryFromScroll: (loadEarlier: MobileNativeChatLoadEarlier) => boolean
  scheduleTailFollow: () => void
}

export function useMobileNativeChatTailFollow(args: {
  conversationIdentity: string
  hasContent: boolean
  scrollToEnd: (animated: boolean) => void
}): MobileNativeChatTailFollow {
  const { conversationIdentity, hasContent, scrollToEnd } = args
  const [atBottom, setAtBottom] = useState(true)
  const followingRef = useRef(true)
  const nearBottomRef = useRef(true)
  const userScrollActiveRef = useRef(false)
  const gestureIdRef = useRef(0)
  const gestureOwnsMomentumRef = useRef(false)
  const detachedGestureIdRef = useRef<number | null>(null)
  const offsetRef = useRef(0)
  const viewportHeightRef = useRef(0)
  const historyRequestRef = useRef<HistoryRequest | null>(null)
  const momentumOwnerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const identityRef = useRef(conversationIdentity)

  const cancelTailFollow = useCallback(() => {
    if (tailTimerRef.current) {
      clearTimeout(tailTimerRef.current)
      tailTimerRef.current = null
    }
  }, [])

  const cancelMomentumOwnerTimer = useCallback(() => {
    if (momentumOwnerTimerRef.current) {
      clearTimeout(momentumOwnerTimerRef.current)
      momentumOwnerTimerRef.current = null
    }
  }, [])

  const scheduleTailFollow = useCallback(() => {
    cancelTailFollow()
    if (!followingRef.current || userScrollActiveRef.current) {
      return
    }
    tailTimerRef.current = setTimeout(() => {
      tailTimerRef.current = null
      if (followingRef.current && !userScrollActiveRef.current) {
        scrollToEnd(true)
      }
    }, TAIL_FOLLOW_DELAY_MS)
  }, [cancelTailFollow, scrollToEnd])

  const attachTailFollow = useCallback(() => {
    if (historyRequestRef.current) {
      historyRequestRef.current.userIntent = true
    }
    cancelMomentumOwnerTimer()
    userScrollActiveRef.current = false
    gestureOwnsMomentumRef.current = false
    detachedGestureIdRef.current = null
    followingRef.current = true
    nearBottomRef.current = true
    setAtBottom(true)
    cancelTailFollow()
  }, [cancelMomentumOwnerTimer, cancelTailFollow])

  const detachTail = useCallback(() => {
    if (historyRequestRef.current) {
      historyRequestRef.current.userIntent = false
    }
    followingRef.current = false
    cancelTailFollow()
  }, [cancelTailFollow])

  const followTail = useCallback(
    (animated: boolean) => {
      attachTailFollow()
      scrollToEnd(animated)
    },
    [attachTailFollow, scrollToEnd]
  )

  const followTailAfterLayout = useCallback(() => {
    attachTailFollow()
    scheduleTailFollow()
  }, [attachTailFollow, scheduleTailFollow])

  const settleHistoryRequest = useCallback(
    (request: HistoryRequest, madeProgress: boolean) => {
      if (historyRequestRef.current !== request) {
        return
      }
      historyRequestRef.current = null
      const shouldFollow = request.userIntent ?? (madeProgress ? false : request.restoreFollowing)
      if (madeProgress && request.userIntent === null) {
        detachedGestureIdRef.current = request.triggeringGesture
      }
      followingRef.current = shouldFollow
      if (shouldFollow) {
        scheduleTailFollow()
      }
    },
    [scheduleTailFollow]
  )

  const requestHistory = useCallback(
    (loadEarlier: MobileNativeChatLoadEarlier): boolean => {
      if (historyRequestRef.current) {
        return false
      }
      const request: HistoryRequest = {
        restoreFollowing: followingRef.current,
        triggeringGesture: userScrollActiveRef.current ? gestureIdRef.current : null,
        userIntent: null
      }
      historyRequestRef.current = request
      followingRef.current = false
      cancelTailFollow()
      try {
        const completion = loadEarlier()
        if (!completion) {
          settleHistoryRequest(request, false)
          return false
        }
        void completion.then(
          (madeProgress) => settleHistoryRequest(request, madeProgress),
          () => settleHistoryRequest(request, false)
        )
        return true
      } catch (error) {
        settleHistoryRequest(request, false)
        throw error
      }
    },
    [cancelTailFollow, settleHistoryRequest]
  )

  const requestHistoryFromScroll = useCallback(
    (loadEarlier: MobileNativeChatLoadEarlier): boolean =>
      userScrollActiveRef.current ? requestHistory(loadEarlier) : false,
    [requestHistory]
  )

  useLayoutEffect(() => {
    if (identityRef.current === conversationIdentity) {
      return
    }
    identityRef.current = conversationIdentity
    cancelTailFollow()
    cancelMomentumOwnerTimer()
    historyRequestRef.current = null
    followingRef.current = true
    nearBottomRef.current = true
    userScrollActiveRef.current = false
    gestureOwnsMomentumRef.current = false
    detachedGestureIdRef.current = null
    offsetRef.current = 0
    viewportHeightRef.current = 0
    setAtBottom(true)
    if (hasContent) {
      scheduleTailFollow()
    }
  }, [
    cancelMomentumOwnerTimer,
    cancelTailFollow,
    conversationIdentity,
    hasContent,
    scheduleTailFollow
  ])

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    offsetRef.current = contentOffset.y
    viewportHeightRef.current = layoutMeasurement.height
    const nearBottom =
      nativeChatDistanceFromBottom(contentOffset.y, contentSize.height, layoutMeasurement.height) <
      BOTTOM_THRESHOLD
    nearBottomRef.current = nearBottom
    setAtBottom(nearBottom)
  }, [])

  const onScrollBeginDrag = useCallback(() => {
    // Native anchor events update geometry; only a gesture changes follow intent.
    cancelMomentumOwnerTimer()
    detachedGestureIdRef.current = null
    gestureIdRef.current += 1
    gestureOwnsMomentumRef.current = true
    userScrollActiveRef.current = true
    detachTail()
  }, [cancelMomentumOwnerTimer, detachTail])

  const applyGestureEnd = useCallback(() => {
    userScrollActiveRef.current = false
    const request = historyRequestRef.current
    if (
      request?.triggeringGesture === gestureIdRef.current ||
      detachedGestureIdRef.current === gestureIdRef.current
    ) {
      return
    }
    if (request) {
      request.userIntent = nearBottomRef.current
    }
    followingRef.current = nearBottomRef.current
  }, [])

  const onScrollEndDrag = useCallback(() => {
    cancelMomentumOwnerTimer()
    momentumOwnerTimerRef.current = setTimeout(() => {
      momentumOwnerTimerRef.current = null
      gestureOwnsMomentumRef.current = false
      applyGestureEnd()
      detachedGestureIdRef.current = null
    }, 0)
  }, [applyGestureEnd, cancelMomentumOwnerTimer])

  const onMomentumScrollBegin = useCallback(() => {
    if (!gestureOwnsMomentumRef.current) {
      return
    }
    cancelMomentumOwnerTimer()
    userScrollActiveRef.current = true
  }, [cancelMomentumOwnerTimer])

  const onMomentumScrollEnd = useCallback(() => {
    if (!gestureOwnsMomentumRef.current) {
      return
    }
    gestureOwnsMomentumRef.current = false
    applyGestureEnd()
    detachedGestureIdRef.current = null
  }, [applyGestureEnd])

  const onContentSizeChange = useCallback(
    (height: number) => {
      if (followingRef.current && !userScrollActiveRef.current) {
        nearBottomRef.current = true
        setAtBottom(true)
        scrollToEnd(false)
        return
      }
      if (viewportHeightRef.current > 0) {
        const nearBottom =
          nativeChatDistanceFromBottom(offsetRef.current, height, viewportHeightRef.current) <
          BOTTOM_THRESHOLD
        nearBottomRef.current = nearBottom
        setAtBottom(nearBottom)
      }
    },
    [scrollToEnd]
  )

  useEffect(
    () => () => {
      historyRequestRef.current = null
      cancelTailFollow()
      cancelMomentumOwnerTimer()
    },
    [cancelMomentumOwnerTimer, cancelTailFollow]
  )

  return {
    atBottom,
    detachTail,
    followTail,
    followTailAfterLayout,
    onContentSizeChange,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    requestHistory,
    requestHistoryFromScroll,
    scheduleTailFollow
  }
}
