import { useCallback, useRef } from 'react'

// Uncancelled, Android WebView makes a held touch a long-press: it selects text, then cancels it.
function cancelTouchStart(event: TouchEvent): void {
  event.preventDefault()
}

/**
 * A ref for a Pressable held for its duration, e.g. hold-to-dictate. Cancelling `touchstart` stops
 * the WebView generating the long-press whose selection and `touchcancel` end the press. React's
 * own touch listeners are passive, so this is a native listener on the element.
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
