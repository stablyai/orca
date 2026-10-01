import { useCallback, useRef } from 'react'

/** Without it, Android WebView turns the held touch into a long-press: it selects text and cancels the touch. */
function cancelTouchStart(event: TouchEvent): void {
  event.preventDefault()
}

/**
 * A ref for a Pressable held for its duration, e.g. hold-to-dictate. Cancelling `touchstart` stops
 * the WebView from generating the long-press gesture whose selection and `touchcancel` end the press.
 * React's own touch listeners are passive, so this has to be a native listener on the element.
 */
export function useHoldPressTouchRef(active: boolean) {
  const releaseRef = useRef<(() => void) | null>(null)
  return useCallback(
    (node: unknown) => {
      releaseRef.current?.()
      releaseRef.current = null
      if (active && node instanceof HTMLElement) {
        node.addEventListener('touchstart', cancelTouchStart, { passive: false })
        releaseRef.current = () => node.removeEventListener('touchstart', cancelTouchStart)
      }
    },
    [active]
  )
}
