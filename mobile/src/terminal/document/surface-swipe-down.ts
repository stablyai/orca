import { getTotalScale } from './cell-metrics'
import type { TerminalDocumentScope } from './document-scope'
import { touchesInRoot } from './document-host-seams'
import { notify } from './host-notify'

// A release this far below its start, mostly vertical, reads as "swipe down" (the host may dismiss the keyboard).
const SWIPE_DOWN_MIN_PX = 56
// This far right, mostly horizontal, reads as "swipe back", like the stack's own swipe-back.
const SWIPE_BACK_MIN_PX = 80

// The swipe still scrolls scrollback; the host only learns the gesture happened.
export function reportSwipeDown(
  scope: TerminalDocumentScope,
  released: Touch | undefined,
  // A zoomed terminal wider than its viewport pans sideways, so a horizontal drag isn't a swipe back there.
  pansHorizontally = false
) {
  const { swipeStartX, swipeStartY } = scope.touchGesture
  // The lift can land past the last touchmove, so classify on where the finger came up.
  const lastX = released?.clientX ?? scope.touchGesture.lastX
  const lastY = released?.clientY ?? scope.touchGesture.lastY
  scope.touchGesture.swipeStartX = null
  scope.touchGesture.swipeStartY = null
  if (swipeStartX === null || swipeStartY === null) {
    return
  }
  const dy = lastY - swipeStartY
  const dx = lastX - swipeStartX
  if (dy >= SWIPE_DOWN_MIN_PX && dy > 2 * Math.abs(dx)) {
    notify(scope, { type: 'terminal-swipe-down' })
  } else if (!pansHorizontally && dx >= SWIPE_BACK_MIN_PX && dx > 2 * Math.abs(dy)) {
    notify(scope, { type: 'terminal-swipe-back' })
  }
}

export function markSwipeStart(scope: TerminalDocumentScope, touch: Touch | null) {
  scope.touchGesture.swipeStartX = touch?.clientX ?? null
  scope.touchGesture.swipeStartY = touch?.clientY ?? null
}

export function terminalPansHorizontally(scope: TerminalDocumentScope): boolean {
  const element = scope.term?.element
  return !!element && element.scrollWidth * getTotalScale(scope) > scope.viewportRect().width + 1
}

export function reportSwipeRelease(scope: TerminalDocumentScope, e: TouchEvent) {
  const released = e.changedTouches ? touchesInRoot(scope.root, e.changedTouches)[0] : undefined
  reportSwipeDown(scope, released, terminalPansHorizontally(scope))
}
