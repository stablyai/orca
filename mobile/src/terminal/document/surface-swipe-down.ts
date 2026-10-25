import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'

// A release this far below its start, mostly vertical, reads as "swipe down" (the host may dismiss the keyboard).
const SWIPE_DOWN_MIN_PX = 56

// The swipe still scrolls scrollback; the host only learns the gesture happened.
export function reportSwipeDown(scope: TerminalDocumentScope, released: Touch | undefined) {
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
  if (dy >= SWIPE_DOWN_MIN_PX && dy > 2 * Math.abs(lastX - swipeStartX)) {
    notify(scope, { type: 'terminal-swipe-down' })
  }
}
