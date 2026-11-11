import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type {
  GestureResponderEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView
} from 'react-native'
import {
  sameSmartKeySet,
  type AgentSmartKeySet
} from '../../../../src/shared/terminal/input/agent-smart-keys'

// The same movement the Duo rail allows before a touch stops counting as a press.
const PRESS_MOVE_SLOP = 8
// On the page a tap's press is the click after touchend; hold the row until then, or this long.
const RELEASE_SETTLE_MS = 300

/** A web click with no pointer behind it: VoiceOver, Switch Control or a keyboard. */
export function isAccessibilityClick(event: GestureResponderEvent): boolean {
  return event.type === 'click' && 'detail' in event.nativeEvent && event.nativeEvent.detail === 0
}

/** A web click from a finger or mouse; one that never pressed its key landed on a key that moved. */
function isPointerClick(event: GestureResponderEvent): boolean {
  return event.type === 'click' && !isAccessibilityClick(event)
}

/**
 * Touch rules for the terminal key row: a key fires on release only if the row neither scrolled
 * nor moved under the finger since it went down, and `shown` holds still from touch-down until that
 * touch's press has landed. A new `shown` scrolls the row back to its start.
 */
export function useTerminalKeyRowTouch({
  scrollRef,
  latest,
  cancelAccessoryRepeat
}: {
  scrollRef: RefObject<ScrollView | null>
  latest: AgentSmartKeySet | null
  cancelAccessoryRepeat: () => void
}) {
  const [shown, setShown] = useState(latest)
  const touchRef = useRef({ down: false, moved: false, x: 0, y: 0 })
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressRevisionRef = useRef(0)
  const armedRef = useRef(new Map<string, number>())
  const scrollXRef = useRef(0)
  const latestRef = useRef(latest)
  // From touch-down until that touch's press lands (or the settle timer runs out).
  const holding = () => touchRef.current.down || settleTimerRef.current !== null
  const show = useCallback(() => {
    setShown((current) =>
      sameSmartKeySet(current, latestRef.current) ? current : latestRef.current
    )
  }, [])
  useEffect(() => {
    latestRef.current = latest
    if (!holding()) {
      show()
    }
  }, [latest, show])
  const resetTo = useRef(shown)
  useEffect(() => {
    if (resetTo.current !== shown) {
      resetTo.current = shown
      scrollRef.current?.scrollTo({ x: 0, animated: false })
    }
  }, [scrollRef, shown])

  // Scrolls on the page come only as DOM scroll events; onScrollBeginDrag never fires there.
  const cancelPresses = useCallback(() => {
    pressRevisionRef.current += 1
    cancelAccessoryRepeat()
  }, [cancelAccessoryRepeat])

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])
  useEffect(() => clearSettleTimer, [clearSettleTimer])
  const settle = useCallback(() => {
    clearSettleTimer()
    if (!touchRef.current.down) {
      show()
    }
  }, [clearSettleTimer, show])
  const released = useCallback(() => {
    touchRef.current.down = false
    settleTimerRef.current ??= setTimeout(settle, RELEASE_SETTLE_MS)
  }, [settle])

  return {
    shown,
    rowTouchHandlers: {
      onTouchStart: (event: GestureResponderEvent) => {
        const { pageX, pageY } = event.nativeEvent
        touchRef.current = { down: true, moved: false, x: pageX, y: pageY }
        clearSettleTimer()
      },
      onTouchMove: (event: GestureResponderEvent) => {
        const { pageX, pageY } = event.nativeEvent
        const start = touchRef.current
        if (!start.moved && Math.hypot(pageX - start.x, pageY - start.y) > PRESS_MOVE_SLOP) {
          start.moved = true
          cancelPresses()
        }
      },
      onTouchEnd: released,
      onTouchCancel: () => {
        cancelPresses()
        released()
      }
    },
    // Only a finger moving the row cancels: the page also reports settling, focus and reset scrolls.
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = event.nativeEvent.contentOffset.x
      const moved = x !== scrollXRef.current
      scrollXRef.current = x
      if (moved && touchRef.current.down) {
        cancelPresses()
      }
    },
    /** Marks a key as pressed; call from onPressIn. */
    arm: (id: string): void => {
      armedRef.current.set(id, pressRevisionRef.current)
    },
    /** Whether a key armed by a touch still counts, for a hold that starts before release. */
    stillArmed: (id: string): boolean => armedRef.current.get(id) === pressRevisionRef.current,
    /** Runs a key's action on release unless the row moved since it was armed, then lets the row change. */
    fire: (id: string, event: GestureResponderEvent, action: () => void): void => {
      const armedAt = armedRef.current.get(id)
      armedRef.current.delete(id)
      if (armedAt === undefined ? !isPointerClick(event) : armedAt === pressRevisionRef.current) {
        action()
      }
      settle()
    }
  }
}
