import { useCallback, useRef } from 'react'

export type KeyboardPersistingTaps = 'always' | 'handled'

// Why: native and test renderers have no DOM, so reaching HTMLElement there throws.
// A native host ref can still sit under a defined HTMLElement without addEventListener.
const hasDom = (): boolean => typeof HTMLElement !== 'undefined'

function isDomElement(node: unknown): node is HTMLElement {
  return hasDom() && node instanceof HTMLElement && typeof node.addEventListener === 'function'
}

export function isTextField(element: Element | null): boolean {
  if (!hasDom() || !(element instanceof HTMLElement)) {
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
// A touch long press focuses the Pressable without a mousedown; its blur would end a held press.
export function keepTextFocusThroughTaps(
  container: HTMLElement,
  mode: KeyboardPersistingTaps
): () => void {
  const keepFocus = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (!isTextField(document.activeElement) || !target || isTextField(target)) {
      return
    }
    if (mode === 'handled' && !isPressableInside(container, target)) {
      return
    }
    event.preventDefault()
  }
  // Touch only: RN Web starts touch presses on touchstart, but mouse presses on the mousedown a canceled pointerdown suppresses.
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      keepFocus(event)
    }
  }
  container.addEventListener('mousedown', keepFocus, true)
  container.addEventListener('pointerdown', onPointerDown, true)
  return () => {
    container.removeEventListener('mousedown', keepFocus, true)
    container.removeEventListener('pointerdown', onPointerDown, true)
  }
}

export function useKeyboardPersistingTaps(mode: KeyboardPersistingTaps) {
  const releaseRef = useRef<(() => void) | null>(null)
  return useCallback(
    (node: unknown) => {
      releaseRef.current?.()
      releaseRef.current = isDomElement(node) ? keepTextFocusThroughTaps(node, mode) : null
    },
    [mode]
  )
}
