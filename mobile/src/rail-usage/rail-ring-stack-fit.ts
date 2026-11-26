/** How a column of usage rings fits a band of the rail. */
export type RailRingStackFit = {
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
}): RailRingStackFit {
  const { count, room, ring, overhang, gap, minGap, paddingTop, paddingBottom, peek } = args
  const item = ring + overhang
  const layout = (clear: number, endClear: number, height: number | null): RailRingStackFit => ({
    gap: clear + overhang,
    paddingBottom: endClear + overhang,
    height,
    pitch: item + clear
  })
  if (room === null || count <= 1) {
    return layout(gap, paddingBottom, null)
  }
  const items = count * item
  if (paddingTop + items + (count - 1) * gap + paddingBottom <= room) {
    return layout(gap, paddingBottom, null)
  }
  const tightBottom = Math.min(paddingBottom, 2)
  const tightGap = Math.floor((room - paddingTop - items - tightBottom) / (count - 1))
  if (tightGap >= minGap) {
    return layout(Math.min(gap, tightGap), tightBottom, null)
  }
  const pitch = item + minGap
  const shown = Math.max(1, Math.floor((room - peek - paddingTop - item) / pitch) + 1)
  return layout(minGap, tightBottom, paddingTop + (shown - 1) * pitch + item + 1 + peek)
}
