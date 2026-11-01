import { useLayoutEffect, type RefObject } from 'react'

// aria-hidden only hides a covered view from screen readers; inert also takes it out of the Tab order.
export function useCoveredInert(ref: RefObject<unknown>, covered: boolean): void {
  useLayoutEffect(() => {
    const node = ref.current
    if (!(node instanceof HTMLElement)) {
      return
    }
    node.inert = covered
    const active = document.activeElement
    if (covered && active instanceof HTMLElement && node.contains(active)) {
      active.blur()
    }
  }, [ref, covered])
}
