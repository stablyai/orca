import { typography } from '../theme/mobile-theme'

/**
 * Below this, iOS Safari and every iOS WebView zoom the page when an input takes focus.
 *
 * Exported because the floor is the rule and this constant is the only statement of it. The
 * census over a page route's closure reads this number out of this file rather than restating it,
 * so an input that declares a literal already at or above it is on the floor by construction and
 * needs no binding — and a floor that moved would move both halves together.
 */
export const TEXT_INPUT_FONT_SIZE_FLOOR = 16

/**
 * Web sibling: the app's body size, raised to the size that stops the page being zoomed.
 *
 * iOS zooms on focus of any input under 16px and does not zoom back out, so the document the
 * keyboard seam is measuring ends up at a scale other than 1 for the whole of a typing session.
 * The seam answers 0 there on purpose — geometry cannot separate a zoom from a keyboard — so
 * without this the commit bar and the note composer would never lift on the platform they were
 * written for.
 *
 * The font size rather than `maximum-scale=1` on the viewport meta, which was the first fix and
 * was wrong: Android WebView honours it and would have taken deliberate pinch zoom away from
 * low-vision users to solve a problem only iOS has.
 *
 * `Math.max` rather than the constant, so a theme that raises the body size past 16 keeps it.
 */
export const TEXT_INPUT_FONT_SIZE = Math.max(typography.bodySize, TEXT_INPUT_FONT_SIZE_FLOOR)
