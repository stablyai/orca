import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent
} from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  MobileNativeChatScrollCoordinator,
  type MobileNativeChatScrollMetrics
} from './mobile-native-chat-scroll-coordinator'

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>
type InteractionPhase = 'idle' | 'dragging' | 'awaiting-momentum' | 'momentum'

export function useMobileNativeChatScroll(args: {
  sessionKey: string
  hasData: boolean
  listRef: React.RefObject<FlatList<NativeChatMessage> | null>
}): {
  showJumpToLatest: boolean
  followLatest: () => void
  onScroll: (event: ScrollEvent) => void
  onScrollBeginDrag: (event: ScrollEvent) => void
  onScrollEndDrag: (event: ScrollEvent) => void
  onMomentumScrollBegin: () => void
  onMomentumScrollEnd: (event: ScrollEvent) => void
  onContentSizeChange: (width?: number, height?: number) => void
  onLayout: (event: LayoutChangeEvent) => void
} {
  const coordinatorRef = useRef<MobileNativeChatScrollCoordinator | null>(null)
  if (coordinatorRef.current === null) {
    coordinatorRef.current = new MobileNativeChatScrollCoordinator()
  }
  const coordinator = coordinatorRef.current
  const latestMetricsRef = useRef<MobileNativeChatScrollMetrics | null>(null)
  const contentHeightRef = useRef<number | null>(null)
  const layoutHeightRef = useRef<number | null>(null)
  const activeSessionKeyRef = useRef(args.sessionKey)
  const hasDataRef = useRef(args.hasData)
  const tailFrameRef = useRef<number | null>(null)
  const settleFrameRef = useRef<number | null>(null)
  const tailAnimatedRef = useRef(false)
  const interactionPhaseRef = useRef<InteractionPhase>('idle')
  const interactionGenerationRef = useRef(0)
  const showJumpToLatestRef = useRef(false)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  activeSessionKeyRef.current = args.sessionKey
  hasDataRef.current = args.hasData

  const isCurrentSession = useCallback(
    () => activeSessionKeyRef.current === args.sessionKey,
    [args.sessionKey]
  )

  const syncPresentation = useCallback(() => {
    const next = coordinator.shouldShowJumpToLatest()
    if (next === showJumpToLatestRef.current) {
      return
    }
    showJumpToLatestRef.current = next
    setShowJumpToLatest(next)
  }, [coordinator])

  const updateMetrics = useCallback(
    (metrics: MobileNativeChatScrollMetrics) => {
      latestMetricsRef.current = metrics
      coordinator.updateMetrics(metrics)
    },
    [coordinator]
  )

  const cancelTail = useCallback(() => {
    if (tailFrameRef.current !== null) {
      cancelAnimationFrame(tailFrameRef.current)
      tailFrameRef.current = null
    }
    tailAnimatedRef.current = false
  }, [])

  const requestTail = useCallback(
    (animated: boolean) => {
      if (!hasDataRef.current || !coordinator.shouldFollowTail()) {
        return
      }
      tailAnimatedRef.current ||= animated
      if (tailFrameRef.current !== null) {
        return
      }
      tailFrameRef.current = requestAnimationFrame(() => {
        tailFrameRef.current = null
        const shouldAnimate = tailAnimatedRef.current
        tailAnimatedRef.current = false
        if (coordinator.shouldFollowTail()) {
          const metrics = latestMetricsRef.current
          const contentHeight = contentHeightRef.current ?? metrics?.contentSize.height
          const layoutHeight = layoutHeightRef.current ?? metrics?.layoutMeasurement.height
          if (contentHeight !== undefined && layoutHeight !== undefined) {
            const offset = Math.max(0, contentHeight - layoutHeight)
            args.listRef.current?.scrollToOffset({ offset, animated: shouldAnimate })
          } else {
            args.listRef.current?.scrollToEnd({ animated: shouldAnimate })
          }
        }
      })
    },
    [args.listRef, coordinator]
  )

  const cancelSettle = useCallback(() => {
    if (settleFrameRef.current !== null) {
      cancelAnimationFrame(settleFrameRef.current)
      settleFrameRef.current = null
    }
  }, [])

  const finishInteraction = useCallback(() => {
    cancelSettle()
    interactionPhaseRef.current = 'idle'
    coordinator.finishInteraction()
    syncPresentation()
    requestTail(false)
  }, [cancelSettle, coordinator, requestTail, syncPresentation])

  useLayoutEffect(() => {
    cancelTail()
    cancelSettle()
    interactionGenerationRef.current += 1
    interactionPhaseRef.current = 'idle'
    latestMetricsRef.current = null
    contentHeightRef.current = null
    layoutHeightRef.current = null
    coordinator.reset()
    syncPresentation()
    requestTail(false)
  }, [args.sessionKey, cancelSettle, cancelTail, coordinator, requestTail, syncPresentation])

  useEffect(
    () => () => {
      cancelTail()
      cancelSettle()
      interactionGenerationRef.current += 1
      interactionPhaseRef.current = 'idle'
    },
    [cancelSettle, cancelTail]
  )

  const onScroll = useCallback(
    (event: ScrollEvent) => {
      if (!isCurrentSession()) {
        return
      }
      updateMetrics(event.nativeEvent)
      syncPresentation()
    },
    [isCurrentSession, syncPresentation, updateMetrics]
  )

  const onScrollBeginDrag = useCallback(
    (event: ScrollEvent) => {
      if (!isCurrentSession()) {
        return
      }
      cancelTail()
      cancelSettle()
      interactionGenerationRef.current += 1
      interactionPhaseRef.current = 'dragging'
      coordinator.beginInteraction()
      updateMetrics(event.nativeEvent)
      syncPresentation()
    },
    [cancelSettle, cancelTail, isCurrentSession, syncPresentation, updateMetrics]
  )

  const onScrollEndDrag = useCallback(
    (event: ScrollEvent) => {
      if (!isCurrentSession()) {
        return
      }
      updateMetrics(event.nativeEvent)
      cancelSettle()
      interactionPhaseRef.current = 'awaiting-momentum'
      if (Math.abs(event.nativeEvent.velocity?.y ?? 0) > 0) {
        return
      }
      const generation = interactionGenerationRef.current
      settleFrameRef.current = requestAnimationFrame(() => {
        settleFrameRef.current = null
        if (
          interactionGenerationRef.current !== generation ||
          interactionPhaseRef.current !== 'awaiting-momentum'
        ) {
          return
        }
        finishInteraction()
      })
    },
    [cancelSettle, finishInteraction, isCurrentSession, updateMetrics]
  )

  const onMomentumScrollBegin = useCallback(() => {
    if (!isCurrentSession() || interactionPhaseRef.current !== 'awaiting-momentum') {
      return
    }
    cancelTail()
    cancelSettle()
    interactionPhaseRef.current = 'momentum'
    coordinator.suspendFollowing()
  }, [cancelSettle, cancelTail, coordinator, isCurrentSession])

  const onMomentumScrollEnd = useCallback(
    (event: ScrollEvent) => {
      if (!isCurrentSession() || interactionPhaseRef.current !== 'momentum') {
        return
      }
      updateMetrics(event.nativeEvent)
      finishInteraction()
    },
    [finishInteraction, isCurrentSession, updateMetrics]
  )

  const followLatest = useCallback(() => {
    cancelSettle()
    interactionGenerationRef.current += 1
    interactionPhaseRef.current = 'idle'
    coordinator.followLatest()
    syncPresentation()
    requestTail(true)
  }, [cancelSettle, coordinator, requestTail, syncPresentation])

  const onContentSizeChange = useCallback(
    (_width?: number, height?: number) => {
      if (!isCurrentSession()) {
        return
      }
      if (height !== undefined && contentHeightRef.current === height) {
        return
      }
      if (height !== undefined) {
        contentHeightRef.current = height
      }
      const current = latestMetricsRef.current
      if (current && height !== undefined) {
        updateMetrics({
          ...current,
          contentSize: { height }
        })
        syncPresentation()
      }
      requestTail(false)
    },
    [isCurrentSession, requestTail, syncPresentation, updateMetrics]
  )
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!isCurrentSession()) {
        return
      }
      const height = event.nativeEvent.layout.height
      if (layoutHeightRef.current === height) {
        return
      }
      layoutHeightRef.current = height
      const current = latestMetricsRef.current
      if (current) {
        updateMetrics({
          ...current,
          layoutMeasurement: { height }
        })
        syncPresentation()
      }
      requestTail(false)
    },
    [isCurrentSession, requestTail, syncPresentation, updateMetrics]
  )

  return {
    showJumpToLatest,
    followLatest,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
    onContentSizeChange,
    onLayout
  }
}
