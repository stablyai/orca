/** Native renders a step on React's schedule, so its timed cost also holds whatever ran first. */
export const REVEAL_STEP_TIMED_EXACTLY = false

export function renderRevealStep(render: () => void): void {
  render()
}
