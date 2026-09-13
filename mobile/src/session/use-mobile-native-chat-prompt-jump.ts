import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { FlatList, ViewToken } from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { mobileNativeChatLatestPromptIndex } from './mobile-native-chat-prompt-anchor'

const SCROLL_RETRY_MS = 120

type ScrollToIndexFailure = {
  index: number
  highestMeasuredFrameIndex: number
  averageItemLength: number
}

/** Drives the jump-to-prompt control: shown at the bottom of the list while the
 *  newest prompt has scrolled out of view, i.e. under a reply taller than the screen. */
export function useMobileNativeChatPromptJump(
  listRef: RefObject<FlatList<NativeChatMessage> | null>,
  data: readonly NativeChatMessage[],
  atBottom: boolean
): {
  showPromptJump: boolean
  onJumpToPrompt: () => void
  onViewableItemsChanged: (info: { viewableItems: ViewToken[] }) => void
  onScrollToIndexFailed: (info: ScrollToIndexFailure) => void
} {
  // Null until the list first reports, so the control cannot flash before layout.
  const [viewableKeys, setViewableKeys] = useState<ReadonlySet<string> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
      }
    },
    []
  )

  // Why a ref: FlatList throws if onViewableItemsChanged changes identity after mount.
  const onViewableItemsChanged = useRef((info: { viewableItems: ViewToken[] }) => {
    setViewableKeys(new Set(info.viewableItems.map((token) => token.key)))
  }).current

  const promptIndex = mobileNativeChatLatestPromptIndex(data)
  const promptId = promptIndex === null ? null : data[promptIndex].id
  const showPromptJump =
    atBottom && promptId !== null && viewableKeys !== null && !viewableKeys.has(promptId)

  const onJumpToPrompt = useCallback(() => {
    if (promptIndex !== null) {
      listRef.current?.scrollToIndex({ index: promptIndex, viewPosition: 0, animated: true })
    }
  }, [listRef, promptIndex])

  // An off-screen row may not be measured yet: land near it, then retry once laid out.
  const onScrollToIndexFailed = useCallback(
    (info: ScrollToIndexFailure) => {
      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: true
      })
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
      }
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null
        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0, animated: true })
      }, SCROLL_RETRY_MS)
    },
    [listRef]
  )

  return { showPromptJump, onJumpToPrompt, onViewableItemsChanged, onScrollToIndexFailed }
}
