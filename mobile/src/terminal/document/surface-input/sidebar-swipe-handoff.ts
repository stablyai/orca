// A leftward swipe that the page turns into opening its tabs sidebar. The terminal's touch engine
// decides with the same thresholds as the page's own content swipe, then forwards the touch.

/** A swipe is decided once it has moved this far (CSS px). */
export const SIDEBAR_SWIPE_SLOP = 10
/** How much more sideways than vertical a swipe must be to count as sideways. */
export const SIDEBAR_SWIPE_HORIZONTAL_DOMINANCE = 1.5

/** Whether a drag that has moved (dx, dy) is a leftward sideways swipe; null while it hasn't moved enough. */
export function isLeftwardSwipe(dx: number, dy: number): boolean | null {
  if (Math.abs(dx) < SIDEBAR_SWIPE_SLOP && Math.abs(dy) < SIDEBAR_SWIPE_SLOP) {
    return null
  }
  return dx < 0 && Math.abs(dx) >= Math.abs(dy) * SIDEBAR_SWIPE_HORIZONTAL_DOMINANCE
}

/** Marks an element that decides its own swipes and hands them over, so the page doesn't track them too. */
export const SIDEBAR_SWIPE_OWNER_ATTRIBUTE = 'data-hands-sidebar-swipes'

/** The DOM event the terminal dispatches (bubbling) for each phase of a swipe it hands to the page. */
export const SIDEBAR_SWIPE_EVENT = 'orca-sidebar-swipe'

export type SidebarSwipeDetail =
  | { phase: 'start'; x: number; y: number; at: number }
  | { phase: 'move'; x: number; y: number; at: number }
  | { phase: 'end' | 'cancel' }
