import type { ReservedRect } from '../../modules/orca-reserved-regions/src'

/** The part of a side inset strip below what occludes it, in window points. */
export type SideRailStrip = {
  side: 'left' | 'right'
  width: number
  top: number
  bottom: number
  height: number
}

export function hasTerminalDirectionPadSpace(strip: SideRailStrip | null): strip is SideRailStrip {
  return strip !== null && strip.height >= 224 && strip.width >= 60
}

/** Narrower than a key; the iPhone Duo's status column is 84. */
const MIN_STRIP_WIDTH = 60
/** Room for at least a few keys below the occluded part. */
const MIN_STRIP_HEIGHT = 160

/**
 * The side inset strip a rail of controls can use: a whole-height side inset that something as wide
 * as it occludes only in part, like the iPhone Duo's status column, less that part. Null for any
 * other window, so a landscape iPhone's rounded corners or camera island never get one.
 */
export function getSideRailStrip(args: {
  windowWidth: number
  windowHeight: number
  insets: { top: number; right: number; bottom: number; left: number }
  occlusions: readonly ReservedRect[]
}): SideRailStrip | null {
  const { windowWidth, windowHeight, insets, occlusions } = args
  for (const side of ['right', 'left'] as const) {
    const width = insets[side]
    if (!(width >= MIN_STRIP_WIDTH)) {
      continue
    }
    const stripStart = side === 'right' ? windowWidth - width : 0
    const stripEnd = side === 'right' ? windowWidth : width
    const inStrip = occlusions.filter(
      (region) => region.x < stripEnd && region.x + region.width > stripStart
    )
    // The status column spans the strip's width from a screen edge; a camera island does neither.
    const statusColumn = inStrip.some(
      (region) =>
        region.x <= stripStart + 1 &&
        region.x + region.width >= stripEnd - 1 &&
        (region.y <= 1 || region.y + region.height >= windowHeight - 1)
    )
    if (!statusColumn) {
      continue
    }
    const occluded = inStrip
      .map((region) => ({ from: region.y, to: region.y + region.height }))
      .sort((a, b) => a.from - b.from)
    // The longest run of the strip nothing occludes, between the top and bottom insets.
    let best = { from: 0, to: 0 }
    let cursor = insets.top
    for (const span of [...occluded, { from: windowHeight - insets.bottom, to: windowHeight }]) {
      if (span.from - cursor > best.to - best.from) {
        best = { from: cursor, to: span.from }
      }
      cursor = Math.max(cursor, span.to)
    }
    if (best.to - best.from >= MIN_STRIP_HEIGHT) {
      return {
        side,
        width,
        top: best.from,
        bottom: windowHeight - best.to,
        height: best.to - best.from
      }
    }
  }
  return null
}

/** The strip less what the software keyboard covers of its bottom; null when it covers all of it. */
export function sideRailStripAboveKeyboard(
  strip: SideRailStrip | null,
  keyboardHeight: number
): SideRailStrip | null {
  if (strip === null || keyboardHeight <= strip.bottom) {
    return strip
  }
  const height = strip.height - (keyboardHeight - strip.bottom)
  return height > 0 ? { ...strip, bottom: keyboardHeight, height } : null
}
