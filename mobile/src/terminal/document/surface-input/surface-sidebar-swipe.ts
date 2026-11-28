import type { TerminalDocumentScope } from '../document-scope'
import { getTotalScale } from '../viewport/cell-metrics'
import { getMouseTrackingMode } from './mouse-input-encoding'
import {
  isLeftwardSwipe,
  SIDEBAR_SWIPE_EVENT,
  type SidebarSwipeDetail
} from './sidebar-swipe-handoff'
import { clearLongPress } from './tap-dispatch'

export type TerminalTouchSwipeState = {
  /** Where the one-finger touch began, to tell a sidebar swipe from the terminal's own drags. */
  startX: number
  startY: number
  startAt: number
  /** Undecided until it moves; 'page' once handed to the page's sidebar swipe. */
  swipe: 'undecided' | 'terminal' | 'page'
  /** A touch that just dismissed a selection stays the terminal's. */
  keepTouchId: number | null
}

/** At touch start: a single finger may become a swipe; anything else is the terminal's. */
export function startTouchSwipe(
  scope: TerminalDocumentScope,
  touches: ArrayLike<Touch>,
  at: number
) {
  const touch = touches.length === 1 ? touches[0] : undefined
  if (touch && touch.identifier !== scope.touchGesture.keepTouchId) {
    scope.touchGesture.startX = touch.clientX
    scope.touchGesture.startY = touch.clientY
    scope.touchGesture.startAt = at
    scope.touchGesture.swipe = swipeMayGoToPage(scope)
  }
  scope.touchGesture.keepTouchId = null
}

/** Ends a swipe handed to the page (true when there was one); every touch starts as the terminal's. */
export function endPageSwipe(scope: TerminalDocumentScope, phase: 'end' | 'cancel'): boolean {
  const handed = scope.touchGesture.swipe === 'page'
  scope.touchGesture.swipe = 'terminal'
  if (handed) {
    handSwipe(scope, { phase })
  }
  return handed
}

// A one-finger drag may become the page's sidebar swipe only where it can't mean anything to the
// terminal sideways: the page asked for swipes, the grid fits the screen (no sideways pan, no pinch
// zoom), and the program isn't reading the mouse. Selection touches are kept by tap dispatch.
function swipeMayGoToPage(scope: TerminalDocumentScope): 'undecided' | 'terminal' {
  if (!scope.handsSwipesToPage || !scope.term?.element || scope.userScale !== 1) {
    return 'terminal'
  }
  if (getMouseTrackingMode(scope) !== 'none') {
    return 'terminal'
  }
  const overflows =
    scope.term.element.scrollWidth * getTotalScale(scope) > scope.viewportRect().width + 1
  return overflows ? 'terminal' : 'undecided'
}

function handSwipe(scope: TerminalDocumentScope, detail: SidebarSwipeDetail) {
  scope.surface?.dispatchEvent(new CustomEvent(SIDEBAR_SWIPE_EVENT, { bubbles: true, detail }))
}

// Decides an undecided touch once it has moved, and forwards a handed-off one. True when the page owns it.
export function forwardSwipe(
  scope: TerminalDocumentScope,
  touches: ArrayLike<Touch>,
  at: number
): boolean {
  if (scope.touchGesture.swipe === 'terminal') {
    return false
  }
  const touch = touches.length === 1 ? touches[0] : undefined
  if (scope.touchGesture.swipe === 'page') {
    if (touch) {
      handSwipe(scope, { phase: 'move', x: touch.clientX, y: touch.clientY, at })
    }
    return true
  }
  const leftward =
    touch && !scope.touchGesture.isPinching
      ? isLeftwardSwipe(
          touch.clientX - scope.touchGesture.startX,
          touch.clientY - scope.touchGesture.startY
        )
      : false
  if (leftward === null) {
    return false
  }
  if (!leftward) {
    scope.touchGesture.swipe = 'terminal'
    return false
  }
  // The page owns the rest of this touch: no scroll, momentum, tap or long press from it.
  scope.touchGesture.swipe = 'page'
  scope.touchGesture.active = false
  scope.touchGesture.velY = 0
  scope.tapCandidate = null
  clearLongPress(scope)
  handSwipe(scope, {
    phase: 'start',
    x: scope.touchGesture.startX,
    y: scope.touchGesture.startY,
    at: scope.touchGesture.startAt
  })
  handSwipe(scope, { phase: 'move', x: touch!.clientX, y: touch!.clientY, at })
  return true
}
