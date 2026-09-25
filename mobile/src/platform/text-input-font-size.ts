import { typography } from '../theme/mobile-theme'

/**
 * The font size a text input carries, which is a platform question and not a design one.
 *
 * A phone has no page to zoom, so this is the app's body size and the rendered input is exactly
 * what it was before this module existed. The `.web.ts` sibling is where the difference lives.
 */
export const TEXT_INPUT_FONT_SIZE = typography.bodySize
