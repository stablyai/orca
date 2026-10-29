import { typography } from '../theme/mobile-theme'

// iOS zooms focused inputs below 16px; share this floor with the route-closure census.
export const TEXT_INPUT_FONT_SIZE_FLOOR = 16

// Prevent focus zoom so keyboard geometry remains measurable; preserve larger theme sizes and accessible pinch zoom instead of setting maximum-scale=1.
export const TEXT_INPUT_FONT_SIZE = Math.max(typography.bodySize, TEXT_INPUT_FONT_SIZE_FLOOR)
