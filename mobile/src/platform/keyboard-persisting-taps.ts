import { useCallback, useRef } from 'react'

export type KeyboardPersistingTaps = 'always' | 'handled'

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

// Stop at the container so focusable ancestors outside this bar cannot claim the tap.
function isPressableInside(container: HTMLElement, target: Element): boolean {
  const pressable = target.closest('[tabindex]:not([tabindex="-1"])')
  return pressable !== null && pressable !== container && container.contains(pressable)
}

// RN Web ignores keyboardShouldPersistTaps; prevent mousedown focus theft by Pressables to keep the IME open.
export function keepTextFocusThroughTaps(
  container: HTMLElement,
  mode: KeyboardPersistingTaps
): () => void {
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (!isTextField(document.activeElement) || !target || isTextField(target)) {
      return
    }
    if (mode === 'handled' && !isPressableInside(container, target)) {
      return
    }
    event.preventDefault()
  }
  container.addEventListener('mousedown', onMouseDown, true)
  return () => container.removeEventListener('mousedown', onMouseDown, true)
}

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
