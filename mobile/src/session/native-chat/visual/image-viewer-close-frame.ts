import type { ReservedRect } from '../../../../modules/orca-reserved-regions/src'
import { spacing } from '../../../theme/mobile-theme'
import { getSideRailStrip } from '../../../layout/side-rail-strip'

/** Duo close target. Phones keep the padded button. */
const DUO_CLOSE_SIZE = 44

/**
 * The Duo cover's status glyph, measured on iOS 27.1. The inner display reports only the column,
 * so its row uses this glyph's center.
 */
const STATUS_GLYPH_FROM_EDGE = 29.33
const STATUS_GLYPH_SIZE = 37
const STATUS_ROW_CENTER_FROM_EDGE = STATUS_GLYPH_FROM_EDGE + STATUS_GLYPH_SIZE / 2

export type ImageViewerCloseFrame = {
  top: number
  left: number
  /** Set on a Duo rail. Null keeps the padded phone button. */
  size: number | null
}

type Scene = {
  windowWidth: number
  windowHeight: number
  insets: { top: number; right: number; bottom: number; left: number }
  occlusions: readonly ReservedRect[]
}

function statusColumn(scene: Scene, side: 'left' | 'right', width: number): ReservedRect | null {
  const start = side === 'right' ? scene.windowWidth - width : 0
  const end = start + width
  return (
    scene.occlusions.find(
      (region) =>
        region.x <= start + 1 &&
        region.x + region.width >= end - 1 &&
        (region.y <= 1 || region.y + region.height >= scene.windowHeight - 1)
    ) ?? null
  )
}

function glyphCenter(column: ReservedRect, occlusions: readonly ReservedRect[]): number | null {
  const fromTop = column.y <= 1
  let mark: ReservedRect | null = null
  for (const region of occlusions) {
    const inside =
      region !== column &&
      region.width < column.width - 1 &&
      region.x + region.width > column.x &&
      region.x < column.x + column.width &&
      region.y + region.height > column.y &&
      region.y < column.y + column.height
    if (!inside) {
      continue
    }
    if (mark === null) {
      mark = region
      continue
    }
    const closer = fromTop
      ? region.y + region.height / 2 < mark.y + mark.height / 2
      : region.y + region.height / 2 > mark.y + mark.height / 2
    if (closer) {
      mark = region
    }
  }
  return mark === null ? null : mark.y + mark.height / 2
}

function statusRowCenter(scene: Scene, side: 'left' | 'right', width: number, stripTop: number): number {
  const column = statusColumn(scene, side, width)
  const measured = column === null ? null : glyphCenter(column, scene.occlusions)
  if (measured !== null) {
    return measured
  }
  const fromTop = column !== null ? column.y <= 1 : stripTop > 1
  return fromTop ? STATUS_ROW_CENTER_FROM_EDGE : scene.windowHeight - STATUS_ROW_CENTER_FROM_EDGE
}

/** Phone: below the status bar, on the left. Duo: the status row, a step off the corner and clear of the column. */
export function imageViewerCloseFrame(scene: Scene): ImageViewerCloseFrame {
  const strip = getSideRailStrip(scene)
  if (strip === null) {
    return {
      top: scene.insets.top + spacing.sm,
      left: scene.insets.left + spacing.lg,
      size: null
    }
  }
  const center = statusRowCenter(scene, strip.side, strip.width, strip.top)
  const fromTop = center < scene.windowHeight / 2
  const top = center - DUO_CLOSE_SIZE / 2 + (fromTop ? spacing.sm : -spacing.sm)
  let left = scene.insets.left + spacing.lg + spacing.sm
  if (strip.side === 'left') {
    left = Math.max(left, strip.width + spacing.lg + spacing.sm)
  } else if (left + DUO_CLOSE_SIZE > scene.windowWidth - strip.width - spacing.sm) {
    left = scene.windowWidth - strip.width - spacing.sm - DUO_CLOSE_SIZE
  }
  return { top, left, size: DUO_CLOSE_SIZE }
}
