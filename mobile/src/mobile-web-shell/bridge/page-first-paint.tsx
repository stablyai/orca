/** How the page schedules one frame. `requestAnimationFrame` on a document, a fake in a test. */
export type PageFrameScheduler = (callback: () => void) => void

/**
 * Calls `report` once the browser has painted the commit this was scheduled from. Two frames, not
 * one: an effect runs with the DOM mutated and the frame not yet painted, so the first callback
 * scheduled from it can still run ahead of that paint. Being late costs one frame of a cover that
 * is already up; being early uncovers the view over a tree nothing has drawn.
 */
export function reportAfterFirstPaint(schedule: PageFrameScheduler, report: () => void): void {
  schedule(() => {
    schedule(report)
  })
}
