/** How a column of usage rings fits a band of the rail. */
export type RailRingStackFit = {
  /** Smaller rings when tightening gaps alone cannot fit the complete stack. */
  diameter?: number
  /** Top padding above the first ring. Tightens with the gaps when `tightenTop` is set. */
  paddingTop: number
  /** Layout gap between ring boxes: the label's overhang plus the clear gap below it. */
  gap: number
  /** Layout padding after the last ring box, its label's overhang included. */
  paddingBottom: number
  /** The scroller's height when it shows only some rings, its faded peek included; null fills the band. */
  height: number | null
  /** Distance between ring tops, for snapping a scroller that shows only some. */
  pitch: number
}

/**
 * A ring's full height runs to the bottom of the percent label under it, and every gap is measured
 * from there to the next ring's arc, so no label ever touches the next ring. Keeps the natural
 * spacing when every ring fits. Otherwise it tightens the gaps, then scales rings down to `minRing`.
 * If they still do not fit, it cuts below a whole ring's label with the next ring's edge under a fade.
 */
export function railRingStackFit(args: {
  count: number
  /** The band's height; null before it is measured. */
  room: number | null
  ring: number
  /** How far a ring's percent label hangs below its box. */
  overhang: number
  /** Clear space from a label's bottom to the next ring's top. */
  gap: number
  minGap: number
  paddingTop: number
  /** Clear space below the last label. */
  paddingBottom: number
  /** A faded strip below the cut where the next ring's top edge shows there is more. */
  peek: number
  /** Tighten top padding alongside inter-ring gaps (below a rail Back button, not under the status glyph). */
  tightenTop?: boolean
  /** Smallest readable ring; omit to keep the ring's size when the stack must scroll. */
  minRing?: number
}): RailRingStackFit {
  const {
    count,
    room,
    ring,
    overhang,
    gap,
    minGap,
    paddingTop,
    paddingBottom,
    peek,
    tightenTop = false,
    minRing = ring
  } = args
  const item = ring + overhang
  const layout = (
    top: number,
    clear: number,
    endClear: number,
    height: number | null
  ): RailRingStackFit => ({
    paddingTop: top,
    gap: clear + overhang,
    paddingBottom: endClear + overhang,
    height,
    pitch: item + clear
  })
  if (room === null || count <= 1) {
    return layout(paddingTop, gap, paddingBottom, null)
  }
  const items = count * item
  const gapCount = count - 1
  if (paddingTop + items + gapCount * gap + paddingBottom <= room) {
    return layout(paddingTop, gap, paddingBottom, null)
  }
  const tightBottom = Math.min(paddingBottom, 2)
  const tightGap = tightenTop
    ? Math.floor((room - items - tightBottom) / (gapCount + 1))
    : Math.floor((room - paddingTop - items - tightBottom) / gapCount)
  if (tightGap >= minGap) {
    const clear = Math.min(gap, tightGap)
    return layout(tightenTop ? Math.min(paddingTop, clear) : paddingTop, clear, tightBottom, null)
  }
  const effectiveTop = tightenTop ? Math.min(paddingTop, minGap) : paddingTop
  // Scale the ring and its label together. A second pass at that size either fits or scrolls.
  const diameter = Math.floor(
    (room - effectiveTop - gapCount * minGap - tightBottom) / (count * (1 + overhang / ring))
  )
  if (diameter >= minRing && diameter < ring) {
    return {
      ...railRingStackFit({
        ...args,
        ring: diameter,
        overhang: overhang * (diameter / ring),
        minRing: diameter
      }),
      diameter
    }
  }
  const pitch = item + minGap
  const shown = Math.max(
    1,
    Math.floor((room - peek - effectiveTop - item - (tightenTop ? 1 : 0)) / pitch) + 1
  )
  // The fade covers `peek` at the bottom; the last label has to finish above it once the stack is scrolled to the end.
  return layout(effectiveTop, minGap, peek, effectiveTop + (shown - 1) * pitch + item + 1 + peek)
}
