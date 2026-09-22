/** How the page schedules one frame. `requestAnimationFrame` on a document, a fake in a test. */
export type PageFrameScheduler = (callback: () => void) => void

/**
 * Calls `report` once the browser has painted the commit this was scheduled from.
 *
 * Two frames, not one. An effect runs with the DOM already mutated and the frame not yet painted,
 * so the first callback scheduled from it can still run ahead of that paint; the second cannot,
 * because a frame boundary has passed. Reporting a frame early would uncover the view over a tree
 * the compositor has not drawn yet, which is the empty frame this whole path exists to remove, and
 * the cost of being late is one frame of a cover that is already up.
 */
export function reportAfterFirstPaint(schedule: PageFrameScheduler, report: () => void): void {
  schedule(() => {
    schedule(report)
  })
}
