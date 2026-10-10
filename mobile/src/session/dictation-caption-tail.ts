import { spacing } from '../theme/mobile-theme'

/** Average Latin glyph width as a share of the font size; conservative so two lines rarely overflow. */
const GLYPH_WIDTH_RATIO = 0.6
/** CJK, Hangul, fullwidth forms and emoji render about 1em wide: two narrow-glyph units each. */
const WIDE_GLYPH_UNITS = 2
const WIDE_GLYPH =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic}/u
const CAPTION_LINES = 2
const MIN_CHAR_BUDGET = 24
/** Used before the first layout pass reports the caption width. */
export const DEFAULT_CAPTION_CHAR_BUDGET = 80
/** Snap to a word start only when one is this close, so a long word still shows its end. */
const WORD_SNAP_WINDOW = 16
export const CAPTION_LINE_HEIGHT = 19
/** Why: past 1.5x Dynamic Type two caption lines would crowd the composer they sit above. */
export const CAPTION_MAX_FONT_SCALE = 1.5

function cappedFontScale(fontScale: number): number {
  return Math.min(Math.max(fontScale, 1), CAPTION_MAX_FONT_SCALE)
}

/** How many narrow-glyph units fit in the caption's two lines at this width and Dynamic Type scale. */
export function captionCharBudget(width: number, fontSize: number, fontScale: number): number {
  if (!(width > 0) || !(fontSize > 0)) {
    return DEFAULT_CAPTION_CHAR_BUDGET
  }
  const glyphWidth = fontSize * cappedFontScale(fontScale) * GLYPH_WIDTH_RATIO
  return Math.max(MIN_CHAR_BUDGET, Math.floor(width / glyphWidth) * CAPTION_LINES)
}

/** Reserves both caption lines at the scaled line height so the strip never jumps or clips. */
export function captionStripMinHeight(fontScale: number): number {
  const lineHeight = Math.ceil(CAPTION_LINE_HEIGHT * cappedFontScale(fontScale))
  return lineHeight * CAPTION_LINES + spacing.sm * 2
}

function glyphUnits(glyph: string): number {
  return WIDE_GLYPH.test(glyph) ? WIDE_GLYPH_UNITS : 1
}

/**
 * The newest words of a live caption, led by '…' when older words were cut. `maxUnits` counts a
 * wide (CJK) glyph twice, so a caption in any script fits the same two lines.
 * Why: Android ignores ellipsizeMode="head" past one line, so the cut happens in JS.
 */
export function captionTail(caption: string, maxUnits: number): string {
  const glyphs = Array.from(caption)
  const total = glyphs.reduce((sum, glyph) => sum + glyphUnits(glyph), 0)
  if (total <= maxUnits) {
    return caption
  }
  // Why: the leading '…' takes one unit of the budget.
  let units = 1
  let kept = 0
  for (const glyph of glyphs.toReversed()) {
    const next = units + glyphUnits(glyph)
    // Why: always keep the newest glyph, even when it alone overflows a tiny budget.
    if (next > maxUnits && kept > 0) {
      break
    }
    units = next
    kept += 1
  }
  let tail = glyphs.slice(glyphs.length - kept).join('')
  const boundary = tail.search(/\s/)
  if (boundary >= 0 && boundary < WORD_SNAP_WINDOW && boundary < tail.length - 1) {
    tail = tail.slice(boundary + 1)
  }
  return `…${tail.trimStart()}`
}
