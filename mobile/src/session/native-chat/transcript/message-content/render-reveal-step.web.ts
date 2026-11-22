import { flushSync } from 'react-dom'

/** The web renders each step before returning, so its timed cost is that step's own render. */
export const REVEAL_STEP_TIMED_EXACTLY = true

export function renderRevealStep(render: () => void): void {
  flushSync(render)
}
