import { useCallback, useRef } from 'react'
import type { HoldPressTouchRef } from './hold-press-touch'

function cancelTouchStart(event: TouchEvent): void {
  event.preventDefault()
}

/**
 * Keeps a held press alive in Android WebView. Its long-press ends react-native-web's press twice
 * over, and onLongPress refuses neither: the selection it starts emits `selectionchange`, which
 * terminates the responder, and ~20 ms after `contextmenu` it sends `pointercancel`/`touchcancel`.
 * Cancelling `touchstart` stops the gesture; React's root touch listeners are passive, hence native.
 */
export function holdTouchesOn(element: HTMLElement): () => void {
  element.addEventListener('touchstart', cancelTouchStart, { passive: false })
  return () => element.removeEventListener('touchstart', cancelTouchStart)
}

/** A ref for a Pressable that is held, e.g. hold-to-dictate; inert while `active` is false. */
export function useHoldPressTouchRef(active: boolean): HoldPressTouchRef {
  const releaseRef = useRef<(() => void) | null>(null)
  return useCallback(
    (node: unknown) => {
      releaseRef.current?.()
      releaseRef.current = active && node instanceof HTMLElement ? holdTouchesOn(node) : null
    },
    [active]
  )
}
