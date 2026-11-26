/** How a column of usage rings fits a band of the rail. */
export type RailRingStackFit = {
  gap: number
  paddingBottom: number
  /** The scroller's height when it shows only some rings, its faded peek included; null fills the band. */
  height: number | null
  /** Distance between ring tops, for snapping a scroller that shows only some. */
  pitch: number
}

/**
 * Keeps the natural spacing when every ring fits. Otherwise it tightens the gaps, then shows as
 * many whole rings as fit and cuts in the gap below the last one, so no ring is drawn half-visible: only
 * the next ring's top edge shows, under a fade.
 */
export function railRingStackFit(args: {
  count: number
  /** The band's height; null before it is measured. */
  room: number | null
  ring: number
  /** How far a ring's label hangs below it, which the next gap and the end padding must clear. */
  overhang: number
  gap: number
  minGap: number
  paddingTop: number
  paddingBottom: number
  /** A faded strip below the cut where the next ring's top edge shows there is more. */
  peek: number
}): RailRingStackFit {
  const { count, room, ring, overhang, gap, minGap, paddingTop, paddingBottom, peek } = args
  const natural = { gap, paddingBottom, height: null, pitch: ring + gap }
  if (room === null || count <= 1) {
    return natural
  }
  const rings = count * ring
  if (paddingTop + rings + (count - 1) * gap + paddingBottom <= room) {
    return natural
  }
  const tightBottom = Math.min(paddingBottom, overhang + 2)
  const tightGap = Math.floor((room - paddingTop - rings - tightBottom) / (count - 1))
  if (tightGap >= minGap) {
    return {
      gap: Math.min(gap, tightGap),
      paddingBottom: tightBottom,
      height: null,
      pitch: ring + tightGap
    }
  }
  const pitch = ring + minGap
  const shown = Math.max(1, Math.floor((room - peek - paddingTop - ring - overhang) / pitch) + 1)
  return {
    gap: minGap,
    paddingBottom: tightBottom,
    height: paddingTop + (shown - 1) * pitch + ring + overhang + 1 + peek,
    pitch
  }
}
