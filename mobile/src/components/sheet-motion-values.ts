// The sheet's motion as plain numbers, free of any animation library, so Animated and Reanimated
// callers (and their test mocks) share one source.

// iOS's sheet curve: a quick start that settles gently, so a sheet arrives without a hard stop.
export const SHEET_CURVE = [0.32, 0.72, 0, 1] as const
/** Content that grows or shrinks inside a sheet eases on the same curve. */
export const SHEET_HEIGHT_DURATION_MS = 320
/**
 * Critically damped, so a released sheet or panel settles without a bounce. Reanimated 4 defaults
 * mass to 4, which turned the old `{ damping, stiffness }` pair into a wobble.
 */
export const SETTLE_SPRING = { dampingRatio: 1, duration: 350 } as const
