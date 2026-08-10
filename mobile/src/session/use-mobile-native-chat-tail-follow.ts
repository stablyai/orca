import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { FlatList } from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

const TAIL_SCROLL_DELAY_MS = 16

export function useMobileNativeChatTailFollow(
  listRef: RefObject<FlatList<NativeChatMessage> | null>,
  scopeKey: string,
  dataLength: number,
  keyboardInset: number
): {
  atBottom: boolean
  setViewportAtBottom: (next: boolean) => void
  requestTailScroll: (animated?: boolean) => void
  scrollToLatest: () => void
} {
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animatePendingRef = useRef(false)
  const scopeKeyRef = useRef(scopeKey)

  const cancelPendingScroll = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    animatePendingRef.current = false
  }, [])

  const requestTailScroll = useCallback(
    (animated = false) => {
      if (!atBottomRef.current || dataLength === 0) {
        return
      }
      animatePendingRef.current ||= animated
      if (timerRef.current) {
        return
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const shouldAnimate = animatePendingRef.current
        animatePendingRef.current = false
        if (atBottomRef.current) {
          listRef.current?.scrollToEnd({ animated: shouldAnimate })
        }
      }, TAIL_SCROLL_DELAY_MS)
    },
    [dataLength, listRef]
  )

  const setViewportAtBottom = useCallback(
    (next: boolean) => {
      atBottomRef.current = next
      setAtBottom((current) => (current === next ? current : next))
      if (!next) {
        cancelPendingScroll()
      }
    },
    [cancelPendingScroll]
  )

  const scrollToLatest = useCallback(() => {
    atBottomRef.current = true
    setAtBottom(true)
    requestTailScroll(true)
  }, [requestTailScroll])

  useLayoutEffect(() => {
    if (scopeKeyRef.current !== scopeKey) {
      scopeKeyRef.current = scopeKey
      cancelPendingScroll()
      atBottomRef.current = true
      setAtBottom(true)
    }
  }, [cancelPendingScroll, scopeKey])

  useEffect(() => {
    requestTailScroll(false)
  }, [dataLength, keyboardInset, requestTailScroll, scopeKey])

  useEffect(() => cancelPendingScroll, [cancelPendingScroll])

  return { atBottom, setViewportAtBottom, requestTailScroll, scrollToLatest }
}
