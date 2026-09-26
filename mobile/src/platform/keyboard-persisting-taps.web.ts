import { useCallback, useRef } from 'react'
import type { KeyboardPersistingTaps } from './keyboard-persisting-taps'

export type { KeyboardPersistingTaps } from './keyboard-persisting-taps'

function isTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable
  )
}

/**
 * `keyboardShouldPersistTaps` for the page: react-native-web ignores it, and a Pressable there is a
 * focusable element that takes focus on mousedown, which blurs the text field and closes the IME.
 * `handled` keeps focus only for a tap on something pressable; `always` for any tap.
 */
export function keepTextFocusThroughTaps(
  container: HTMLElement,
  mode: KeyboardPersistingTaps
): () => void {
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (!isTextField(document.activeElement) || !target || isTextField(target)) {
      return
    }
    if (mode === 'handled' && !target.closest('[tabindex]:not([tabindex="-1"])')) {
      return
    }
    event.preventDefault()
  }
  container.addEventListener('mousedown', onMouseDown, true)
  return () => container.removeEventListener('mousedown', onMouseDown, true)
}

/** A ref for the View that holds the taps; on the page that View is its DOM element. */
export function useKeyboardPersistingTaps(mode: KeyboardPersistingTaps) {
  const releaseRef = useRef<(() => void) | null>(null)
  return useCallback(
    (node: unknown) => {
      releaseRef.current?.()
      releaseRef.current = node instanceof HTMLElement ? keepTextFocusThroughTaps(node, mode) : null
    },
    [mode]
  )
}
