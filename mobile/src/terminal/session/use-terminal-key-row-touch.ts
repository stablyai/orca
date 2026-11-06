import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type {
  GestureResponderEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView
} from 'react-native'

// The same movement the Duo rail allows before a touch stops counting as a press.
const PRESS_MOVE_SLOP = 8

/**
 * Touch rules for the terminal key row: a key fires on release only if the row neither scrolled
 * nor moved under the finger since it went down, and `shown` holds still while a finger is down.
 * A new `shown` scrolls the row back to its start.
 */
export function useTerminalKeyRowTouch<T>({
  scrollRef,
  latest,
  sameShown,
  cancelAccessoryRepeat
}: {
  scrollRef: RefObject<ScrollView | null>
  latest: T
  sameShown: (a: T, b: T) => boolean
  cancelAccessoryRepeat: () => void
}) {
  const [shown, setShown] = useState(latest)
  const touchRef = useRef({ down: false, x: 0, y: 0 })
  const pressRevisionRef = useRef(0)
  const armedRef = useRef(new Map<string, number>())
  const scrollXRef = useRef(0)
  const latestRef = useRef(latest)
  const sameShownRef = useRef(sameShown)
  const show = useCallback(() => {
    setShown((current) =>
      sameShownRef.current(current, latestRef.current) ? current : latestRef.current
    )
  }, [])
  useEffect(() => {
    latestRef.current = latest
    sameShownRef.current = sameShown
    if (!touchRef.current.down) {
      show()
    }
  }, [latest, sameShown, show])
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

  const released = useCallback(() => {
    touchRef.current.down = false
    // Let the release's own press land on the key it started on before the row changes.
    setTimeout(show, 0)
  }, [show])

  return {
    shown,
    rowTouchHandlers: {
      onTouchStart: (event: GestureResponderEvent) => {
        const { pageX, pageY } = event.nativeEvent
        touchRef.current = { down: true, x: pageX, y: pageY }
      },
      onTouchMove: (event: GestureResponderEvent) => {
        const { pageX, pageY } = event.nativeEvent
        const start = touchRef.current
        if (Math.hypot(pageX - start.x, pageY - start.y) > PRESS_MOVE_SLOP) {
          cancelPresses()
        }
      },
      onTouchEnd: released,
      onTouchCancel: () => {
        cancelPresses()
        released()
      }
    },
    // The page also reports a scroll when one settles, so only a moved row cancels.
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = event.nativeEvent.contentOffset.x
      if (x !== scrollXRef.current) {
        scrollXRef.current = x
        cancelPresses()
      }
    },
    /** Marks a key as pressed; call from onPressIn. */
    arm: (id: string): void => {
      armedRef.current.set(id, pressRevisionRef.current)
    },
    /** Whether a key armed by a touch still counts, for a hold that starts before release. */
    stillArmed: (id: string): boolean => armedRef.current.get(id) === pressRevisionRef.current,
    /** Runs a key's action on release unless the row scrolled or moved since it was armed. */
    fire: (id: string, action: () => void): void => {
      const armedAt = armedRef.current.get(id)
      armedRef.current.delete(id)
      // An accessibility click has no touch to arm it.
      if (armedAt === undefined || armedAt === pressRevisionRef.current) {
        action()
      }
    }
  }
}
