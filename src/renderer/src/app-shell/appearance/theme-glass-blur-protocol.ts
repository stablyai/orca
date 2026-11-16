/** The blurred copy is this many times smaller than the image on each side; it is soft anyway. */
export const THEME_GLASS_SCALE = 4
/** Blur radius at the reduced size (about 24 CSS px at full size). */
export const THEME_GLASS_BLUR_PX = 6
/** The grid of blurred colors the contrast check reads. */
export const THEME_GLASS_SAMPLE_COLUMNS = 32
export const THEME_GLASS_SAMPLE_ROWS = 18

export type ThemeGlassBlurResult =
  | { ok: true; blob: Blob; samples: Uint8ClampedArray }
  | { ok: false; error: string }
