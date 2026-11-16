import { contrastRatio, over, type Rgba } from '../../../../shared/color/rgba-contrast'
import { MIN_TEXT_CONTRAST } from './plugin-theme-contrast-rules'

/** One glass surface's own color and the text colors drawn on it. */
export type ThemeGlassSurface = { surface: Rgba; texts: readonly Rgba[] }

const TINT_STEP = 0.05

/**
 * The lowest tint at or above `requested` where every text still reads on every blurred color:
 * at least the contrast rules' minimum, or, for text a theme already dims below it, no worse
 * than on the plain surface. Tint 1 is the plain surface, so the search always ends.
 */
export function readableGlassTint(
  requested: number,
  backdrop: readonly Rgba[],
  surfaces: readonly ThemeGlassSurface[]
): number {
  const floors = surfaces.map(({ surface, texts }) =>
    texts.map((text) => Math.min(MIN_TEXT_CONTRAST, contrastRatio(text, surface)))
  )
  for (let tint = requested; tint < 1; tint = Math.min(1, tint + TINT_STEP)) {
    const readable = surfaces.every(({ surface, texts }, surfaceIndex) => {
      const veil: Rgba = [surface[0], surface[1], surface[2], tint]
      return backdrop.every((color) => {
        const painted = over(veil, color)
        return texts.every(
          (text, textIndex) => contrastRatio(text, painted) >= floors[surfaceIndex][textIndex]
        )
      })
    })
    if (readable) {
      return tint
    }
  }
  return 1
}
