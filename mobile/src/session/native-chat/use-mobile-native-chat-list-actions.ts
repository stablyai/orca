import { useCallback } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { MobileNativeChatSendProps } from './composer/MobileNativeChatComposer'
import type { OlderPagePhase } from '../use-mobile-older-page-loader'

/** Send and earlier-page actions shared by the transcript list and its composer. */
export function useMobileNativeChatListActions({
  onSend,
  onClearSendError,
  jumpToTail,
  history: { hasMore, olderPages, loadEarlier: onLoadEarlier },
  recordScrollMetrics,
  scrollMayLoadEarlier
}: {
  onSend: MobileNativeChatSendProps['onSend']
  onClearSendError?: () => void
  jumpToTail: () => void
  history: {
    hasMore: boolean | undefined
    olderPages: OlderPagePhase
    loadEarlier: (() => void) | undefined
  }
  recordScrollMetrics: (event: NativeScrollEvent) => void
  scrollMayLoadEarlier: () => boolean
}): {
  handleSend: typeof onSend
  loadEarlier: () => void
  loadEarlierNearTop: (() => void) | undefined
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
} {
  const handleSend = useCallback(
    async (...send: Parameters<typeof onSend>): Promise<boolean> => {
      // Retire the previous notice before this action can report a new one.
      onClearSendError?.()
      const accepted = await onSend(...send)
      if (!accepted) {
        return false
      }
      jumpToTail()
      return true
    },
    [onSend, onClearSendError, jumpToTail]
  )
  const loadEarlier = useCallback(() => onLoadEarlier?.(), [onLoadEarlier])
  // After failure require a tap; automatic near-top retries could spin forever.
  const loadEarlierNearTop = hasMore && olderPages === 'idle' ? loadEarlier : undefined
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset } = e.nativeEvent
      recordScrollMetrics(e.nativeEvent)
      // Only reader drags trigger native pagination; tail-pin offsets may also look near-top.
      if (contentOffset.y < 60 && scrollMayLoadEarlier()) {
        loadEarlierNearTop?.()
      }
    },
    [loadEarlierNearTop, scrollMayLoadEarlier, recordScrollMetrics]
  )
  return { handleSend, loadEarlier, loadEarlierNearTop, onScroll }
}
