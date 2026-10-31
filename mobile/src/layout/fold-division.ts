import type { ReservedRect } from '../../modules/orca-reserved-regions/src'

/** Where a fold splits a frame: the band from `start` to `end` along the axis it divides. */
export type FoldSplit = {
  /** `vertical`: the fold runs top to bottom and splits left from right (book posture). */
  axis: 'vertical' | 'horizontal'
  start: number
  end: number
  /** The frame's extent along the split, so `size - end` is the room after the fold. */
  size: number
}

type Frame = { x: number; y: number; width: number; height: number }

function isUsable(rect: ReservedRect): boolean {
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

/**
 * The fold that splits `frame` into two usable halves, in the frame's own coordinates; null when
 * none does. A fold only counts when it crosses the frame from edge to edge and leaves room on
 * both sides; one at the frame's edge (a Split View window beside it) splits nothing.
 */
export function getFoldSplit(divisions: readonly ReservedRect[], frame: Frame): FoldSplit | null {
  if (!(frame.width > 0 && frame.height > 0)) {
    return null
  }
  for (const division of divisions) {
    if (!isUsable(division)) {
      continue
    }
    const vertical = division.height >= division.width
    const crossStart = vertical ? division.y - frame.y : division.x - frame.x
    const crossLength = vertical ? division.height : division.width
    const crossSize = vertical ? frame.height : frame.width
    if (crossStart > 0 || crossStart + crossLength < crossSize) {
      continue
    }
    const size = vertical ? frame.width : frame.height
    const start = vertical ? division.x - frame.x : division.y - frame.y
    const end = start + (vertical ? division.width : division.height)
    if (start <= 0 || end >= size) {
      continue
    }
    return { axis: vertical ? 'vertical' : 'horizontal', start, end, size }
  }
  return null
}
