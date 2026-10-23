import { textStyles } from '../theme/mobile-theme'

/**
 * The font size a text input carries, which is a platform question and not a design one.
 *
 * A phone has no page to zoom, so this is the ramp's body size. The `.web.ts` sibling is where the
 * difference lives.
 */
export const TEXT_INPUT_FONT_SIZE = textStyles.body.fontSize
