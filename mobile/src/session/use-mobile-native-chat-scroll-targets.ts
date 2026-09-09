import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { FlatList } from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { mobileNativeChatPromptAnchorIndex } from './mobile-native-chat-prompt-anchor'

/** How long to wait for a row to lay out before retrying a failed jump. */
const SCROLL_RETRY_MS = 120

type ScrollToIndexFailure = {
  index: number
  highestMeasuredFrameIndex: number
  averageItemLength: number
}

/** The transcript's jump targets, kept together because they share one list ref
 *  and one failure path.
 *
 *  - `onScrollToMessage` aligns a message's top to the top of the viewport.
 *  - `onScrollToPrompt` jumps to the prompt an answer belongs to, so a long
 *    reply can be read from the question that started it. It resolves its target
 *    on press rather than on render: `data` changes on every streamed token, so
 *    closing over it would churn `renderItem` and cost a backward scan per
 *    render. A press can only happen after a commit, so the ref is never stale
 *    when it is read. When nothing precedes the message it falls back to the
 *    head of the loaded transcript, so the control never dead-ends.
 *  - `onScrollToIndexFailed` covers both: `scrollToIndex` throws for a row that
 *    has not been measured, so estimate an offset first and retry once laid out. */
export function useMobileNativeChatScrollTargets(
  listRef: RefObject<FlatList<NativeChatMessage> | null>,
  data: readonly NativeChatMessage[]
): {
  onScrollToMessage: (index: number) => void
  onScrollToPrompt: (index: number) => void
  onScrollToIndexFailed: (info: ScrollToIndexFailure) => void
} {
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  const onScrollToMessage = useCallback(
    (index: number) => {
      listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: true })
    },
    [listRef]
  )

  const onScrollToPrompt = useCallback(
    (index: number) => {
      onScrollToMessage(mobileNativeChatPromptAnchorIndex(dataRef.current, index) ?? 0)
    },
    [onScrollToMessage]
  )

  const onScrollToIndexFailed = useCallback(
    (info: ScrollToIndexFailure) => {
      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: true
      })
      setTimeout(() => {
        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0, animated: true })
      }, SCROLL_RETRY_MS)
    },
    [listRef]
  )

  return { onScrollToMessage, onScrollToPrompt, onScrollToIndexFailed }
}
