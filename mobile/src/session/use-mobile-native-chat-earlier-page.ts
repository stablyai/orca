import { useCallback, useRef } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import { createMobileEarlierPageGate } from './mobile-native-chat-earlier-page'

/** A chat surface switch reuses the view, so the gate cannot keep the previous chat's request. */
export function useMobileEarlierPageGate(
  surfaceId: string
): ReturnType<typeof createMobileEarlierPageGate> {
  const gateRef = useRef(createMobileEarlierPageGate())
  const surfaceRef = useRef(surfaceId)
  if (surfaceRef.current !== surfaceId) {
    surfaceRef.current = surfaceId
    gateRef.current = createMobileEarlierPageGate()
  }
  return gateRef.current
}

export function useMobileChatEarlierPageScroll(args: {
  surfaceId: string
  historyHeadId: string | null
  hasMore: boolean | undefined
  loadingEarlier: boolean | undefined
  loadEarlier: () => void
  recordScrollMetrics: (event: NativeScrollEvent) => void
}): (event: NativeSyntheticEvent<NativeScrollEvent>) => void {
  const gate = useMobileEarlierPageGate(args.surfaceId)
  const { historyHeadId, hasMore, loadingEarlier, loadEarlier, recordScrollMetrics } = args
  return useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      recordScrollMetrics(event.nativeEvent)
      if (
        gate.observe({
          offsetY: event.nativeEvent.contentOffset.y,
          historyHeadId,
          hasMore: hasMore === true,
          loadingEarlier: loadingEarlier === true
        })
      ) {
        loadEarlier()
      }
    },
    [gate, historyHeadId, hasMore, loadingEarlier, loadEarlier, recordScrollMetrics]
  )
}
