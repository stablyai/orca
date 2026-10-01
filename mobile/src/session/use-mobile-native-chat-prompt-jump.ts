import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { FlatList, ViewToken } from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { mobileNativeChatLatestPromptIndex } from './mobile-native-chat-prompt-anchor'

const SCROLL_RETRY_MS = 120

type ScrollToIndexFailure = {
  index: number
  highestMeasuredFrameIndex: number
  averageItemLength: number
}

/** Offers the newest loaded prompt when it is off screen at the list's tail. */
export function useMobileNativeChatPromptJump({
  listRef,
  data,
  loadedMessages,
  atBottom,
  onLeaveTail,
  onReturnToTail,
  scopeKey
}: {
  listRef: RefObject<FlatList<NativeChatMessage> | null>
  data: readonly NativeChatMessage[]
  loadedMessages: readonly NativeChatMessage[]
  atBottom: boolean
  onLeaveTail: () => void
  onReturnToTail: () => void
  scopeKey: string
}): {
  showPromptJump: boolean
  onJumpToPrompt: () => void
  cancelPendingJump: () => void
  onScrollToLatest: () => void
  onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => void
  onScrollToIndexFailed: (info: ScrollToIndexFailure) => void
} {
  const [viewable, setViewable] = useState<{ scopeKey: string; keys: ReadonlySet<string> } | null>(
    null
  )
  const latestRef = useRef({ data, scopeKey })
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const targetRef = useRef<{ id: string; scopeKey: string } | null>(null)
  useLayoutEffect(() => {
    latestRef.current = { data, scopeKey }
  }, [data, scopeKey])

  const cancelPendingJump = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    targetRef.current = null
  }, [])
  useEffect(() => cancelPendingJump, [cancelPendingJump, scopeKey])

  const onScrollToLatest = useCallback(() => {
    cancelPendingJump()
    onReturnToTail()
  }, [cancelPendingJump, onReturnToTail])

  // FlatList requires one callback identity throughout its lifetime.
  const onViewableItemsChanged = useRef((info: { viewableItems: ViewToken[] }) => {
    setViewable({
      scopeKey: latestRef.current.scopeKey,
      keys: new Set(info.viewableItems.filter((item) => item.isViewable).map((item) => item.key))
    })
  }).current

  const promptIndex = mobileNativeChatLatestPromptIndex(loadedMessages, data)
  const promptId = promptIndex === null ? null : data[promptIndex].id
  const showPromptJump =
    atBottom && promptId !== null && viewable?.scopeKey === scopeKey && !viewable.keys.has(promptId)

  const onJumpToPrompt = useCallback(() => {
    cancelPendingJump()
    if (promptIndex === null || promptId === null) {
      return
    }
    targetRef.current = { id: promptId, scopeKey }
    onLeaveTail()
    listRef.current?.scrollToIndex({ index: promptIndex, viewPosition: 0, animated: true })
  }, [cancelPendingJump, listRef, onLeaveTail, promptId, promptIndex, scopeKey])

  const onScrollToIndexFailed = useCallback(
    (info: ScrollToIndexFailure) => {
      const target = targetRef.current
      if (!target || target.scopeKey !== latestRef.current.scopeKey) {
        return
      }
      if (retryTimerRef.current !== null) {
        return
      }
      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: true
      })
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        targetRef.current = null
        const latest = latestRef.current
        if (target.scopeKey !== latest.scopeKey) {
          return
        }
        const index = latest.data.findIndex((message) => message.id === target.id)
        if (index !== -1 && latest.data[index].role === 'user') {
          listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true })
        }
      }, SCROLL_RETRY_MS)
    },
    [listRef]
  )

  return {
    showPromptJump,
    onJumpToPrompt,
    cancelPendingJump,
    onScrollToLatest,
    onViewableItemsChanged,
    onScrollToIndexFailed
  }
}
