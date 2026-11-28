/** How a column of usage rings fits a band of the rail. */
export type RailRingStackFit = {
  /** Top padding above the first ring. Tightens with the gaps when `tightenTop` is set. */
  paddingTop: number
  /** Clear space from a label's bottom (or the Items button) to the next ring's top. */
  clearGap: number
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
 * spacing when every ring fits. Otherwise it tightens the gaps, then shows as many whole rings as
 * fit and cuts in the gap below the last one's label: only the next ring's top edge shows, under a fade.
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
  /** Height of a control above the rings, such as the Items button. It takes one of the clear gaps. */
  leadingHeight?: number
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
    leadingHeight = 0
  } = args
  const item = ring + overhang
  const hasLeading = leadingHeight > 0
  const layout = (
    top: number,
    clear: number,
    endClear: number,
    height: number | null
  ): RailRingStackFit => ({
    paddingTop: top,
    clearGap: clear,
    gap: clear + overhang,
    paddingBottom: endClear + overhang,
    height,
    pitch: item + clear
  })
  // A lone ring has no gap to share unless a leading control adds one.
  const gapCount = hasLeading ? count : count - 1
  if (room === null || count <= 0 || gapCount <= 0) {
    return layout(paddingTop, gap, paddingBottom, null)
  }
  const items = leadingHeight + count * item
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
  const pitch = item + minGap
  // The leading control stays put; only the rings below it scroll, and their end gap stays tight.
  const scrollPaddingTop = hasLeading ? 0 : effectiveTop
  const scrollRoom = hasLeading ? room - (effectiveTop + leadingHeight + minGap) : room
  const scrollSlack = tightenTop && !hasLeading ? 1 : 0
  const endClear = hasLeading ? tightBottom : peek
  const shown = Math.max(
    1,
    Math.floor((scrollRoom - peek - scrollPaddingTop - item - scrollSlack) / pitch) + 1
  )
  // The fade covers `peek` at the bottom; the last label has to finish above it once the stack is scrolled to the end.
  return layout(
    effectiveTop,
    minGap,
    endClear,
    scrollPaddingTop + (shown - 1) * pitch + item + 1 + peek
  )
}
