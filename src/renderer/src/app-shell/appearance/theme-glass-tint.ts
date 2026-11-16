import { contrastRatio, over, type Rgba } from '../../../../shared/color/rgba-contrast'

/** A text color and the contrast its rule asks for. */
export type ThemeGlassText = { color: Rgba; min: number }
/** Texts drawn on a layer: the glass surface itself, or a translucent wash painted over it. */
export type ThemeGlassLayer = { wash: Rgba | null; texts: readonly ThemeGlassText[] }
/** One glass surface's own color and the layers drawn on it. */
export type ThemeGlassSurface = { surface: Rgba; layers: readonly ThemeGlassLayer[] }

const TINT_STEP = 0.05
// Why: text a theme already dims below its rule cannot keep its contrast over any image, so it
// may lose at most this share of it instead of forcing opaque chrome.
const DIM_TEXT_TOLERANCE = 0.1

function onLayer(wash: Rgba | null, below: Rgba): Rgba {
  return wash ? over(wash, below) : below
}

/**
 * The lowest tint at or above `requested` where every text still reads on every blurred color:
 * at least its rule's minimum, or, for text already under it on the plain surface, within
 * DIM_TEXT_TOLERANCE of that. Tint 1 is the plain surface, so the search always ends.
 */
export function readableGlassTint(
  requested: number,
  backdrop: readonly Rgba[],
  surfaces: readonly ThemeGlassSurface[]
): number {
  const checks = surfaces.flatMap(({ surface, layers }) =>
    layers.flatMap(({ wash, texts }) =>
      texts.map(({ color, min }) => {
        const plain = contrastRatio(color, onLayer(wash, surface))
        return {
          surface,
          wash,
          color,
          floor: plain >= min ? min : plain * (1 - DIM_TEXT_TOLERANCE)
        }
      })
    )
  )
  for (let tint = requested; tint < 1; tint = Math.min(1, tint + TINT_STEP)) {
    const readable = checks.every(({ surface, wash, color, floor }) => {
      const veil: Rgba = [surface[0], surface[1], surface[2], tint]
      return backdrop.every(
        (sample) => contrastRatio(color, onLayer(wash, over(veil, sample))) >= floor
      )
    })
    if (readable) {
      return tint
    }
  }
  return 1
}
