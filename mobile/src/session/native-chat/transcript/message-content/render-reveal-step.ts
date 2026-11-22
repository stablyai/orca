/** Native renders a step on React's schedule, so its time would also hold whatever ran first: its
 *  replies show as saves would instead of revealing. */
export const REVEAL_STEP_TIMED_EXACTLY = false

export function renderRevealStep(render: () => void): void {
  render()
}
