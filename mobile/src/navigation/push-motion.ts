// One push for the page stack and in-sheet pages, close to iOS: the new screen slides over from the
// right while the one under it drifts a third of the way left and dims a little.
export const PUSH_SLIDE_MS = 300
export const PUSH_CURVE = [0.2, 0.8, 0.2, 1] as const
export const PUSH_EASING_CSS = `cubic-bezier(${PUSH_CURVE.join(', ')})`
export const PUSH_UNDER_SHIFT = 0.3
export const PUSH_UNDER_DIM = 0.12
