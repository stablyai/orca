import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

type Options = {
  listRef: RefObject<FlatList<NativeChatMessage> | null>
  hasMore?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
}

type TailFollow = {
  /** Mirror of the pin, for the jump-to-latest button. */
  atBottom: boolean
  /** Re-pin to the tail (used on send). */
  repin: () => void
  /** Instant follow when pinned — the sole tail-follow, driven by content growth. */
  maybeFollowTail: (dataLength: number) => void
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
  onScrollBeginDrag: () => void
  onScrollEndDrag: () => void
  onMomentumScrollBegin: () => void
  onMomentumScrollEnd: () => void
}

/** Keeps the chat list pinned to the newest message during streaming without the
 *  animation thrash of a per-tick animated scroll: content growth follows the
 *  tail instantly, and the pin is dropped only on a genuine user scroll. */
export function useMobileNativeChatTailFollow({
  listRef,
  hasMore,
  loadingEarlier,
  onLoadEarlier
}: Options): TailFollow {
  // Follow-the-tail flag as a ref, not just state: content-growth handlers read
  // it synchronously (no stale render closure) and it survives the frame race
  // where a growth-induced onScroll would otherwise un-pin us mid-stream.
  const pinnedRef = useRef(true)
  // Un-pin only on genuine user motion: distanceFromBottom is recomputed from
  // onScroll solely while a drag or its momentum is in flight, so a programmatic
  // scrollToEnd (which also fires onScroll) can never flip us off the tail.
  const userDraggingRef = useRef(false)
  const momentumRef = useRef(false)
  const [atBottom, setAtBottom] = useState(true)
  // Coalesce a burst of content-size changes into one scroll per frame. A bulk
  // expand (the "Tools" toggle opening every run) or a keyboard reflow fires
  // onContentSizeChange many times across successive layout passes; calling
  // scrollToEnd synchronously on each one makes the list convulse. One rAF-gated
  // scroll per frame tracks the growing tail smoothly instead.
  const followRafRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (followRafRef.current !== null) {
        cancelAnimationFrame(followRafRef.current)
      }
    },
    []
  )

  const repin = useCallback(() => {
    pinnedRef.current = true
    setAtBottom(true)
  }, [])

  const maybeFollowTail = useCallback(
    (dataLength: number) => {
      if (dataLength <= 0 || !pinnedRef.current || followRafRef.current !== null) {
        return
      }
      followRafRef.current = requestAnimationFrame(() => {
        followRafRef.current = null
        // Re-check the pin at fire time: a drag between schedule and frame may
        // have un-pinned us, and we must not yank the user back to the tail.
        if (pinnedRef.current) {
          listRef.current?.scrollToEnd({ animated: false })
        }
      })
    },
    [listRef]
  )

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
      // Only a user-driven scroll (active drag or its momentum) may change the
      // pin — a growth-induced onScroll must not, or streaming would un-pin us.
      if (userDraggingRef.current || momentumRef.current) {
        const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height)
        // 120px tolerates a streaming chunk or keyboard reflow landing between a
        // follow scroll and its settle without dropping the follow.
        const pinned = distanceFromBottom < 120
        pinnedRef.current = pinned
        setAtBottom(pinned)
      }
      // Near the top — page in older history (fires regardless of drag state).
      if (contentOffset.y < 60 && hasMore && !loadingEarlier) {
        onLoadEarlier?.()
      }
    },
    [hasMore, loadingEarlier, onLoadEarlier]
  )

  const onScrollBeginDrag = useCallback(() => {
    userDraggingRef.current = true
  }, [])
  const onScrollEndDrag = useCallback(() => {
    userDraggingRef.current = false
  }, [])
  const onMomentumScrollBegin = useCallback(() => {
    momentumRef.current = true
  }, [])
  const onMomentumScrollEnd = useCallback(() => {
    momentumRef.current = false
    userDraggingRef.current = false
  }, [])

  return {
    atBottom,
    repin,
    maybeFollowTail,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd
  }
}
