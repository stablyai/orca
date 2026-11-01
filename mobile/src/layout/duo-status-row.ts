import type { ReservedRect } from '../../modules/orca-reserved-regions/src'
import { spacing } from '../theme/mobile-theme'
import type { SideRailStrip } from './side-rail-strip'

/** iOS minimum control. The header's 36pt buttons grow to this with hit slop; the rail draws it outright. */
export const DUO_RAIL_CONTROL_SIZE = 44

/**
 * The Duo cover's status glyph, measured on iOS 27.1: a 37pt mark 29.33pt from the screen edge.
 * The inner display reports only the status column, so its row uses this glyph's center.
 */
export const DUO_STATUS_GLYPH_FROM_EDGE = 29.33
export const DUO_STATUS_GLYPH_SIZE = 37

const STATUS_ROW_CENTER_FROM_EDGE = DUO_STATUS_GLYPH_FROM_EDGE + DUO_STATUS_GLYPH_SIZE / 2

export type DuoRailControlFrame = {
  top: number
  left: number
  size: number
}

type RowArgs = {
  windowWidth: number
  windowHeight: number
  strip: SideRailStrip
  occlusions: readonly ReservedRect[]
}

function statusColumn(args: RowArgs): ReservedRect | null {
  const start = args.strip.side === 'right' ? args.windowWidth - args.strip.width : 0
  const end = start + args.strip.width
  return (
    args.occlusions.find(
      (region) =>
        region.x <= start + 1 &&
        region.x + region.width >= end - 1 &&
        (region.y <= 1 || region.y + region.height >= args.windowHeight - 1)
    ) ?? null
  )
}

function statusGlyph(
  column: ReservedRect,
  occlusions: readonly ReservedRect[]
): ReservedRect | null {
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
    const closerToEdge = fromTop
      ? region.y + region.height / 2 < mark.y + mark.height / 2
      : region.y + region.height / 2 > mark.y + mark.height / 2
    if (closerToEdge) {
      mark = region
    }
  }
  return mark
}

/**
 * Below the reported status occlusion, on the status cluster's midX.
 * The full control stays inside the column. A bottom column clears upward.
 */
export function duoRailBackFrame(args: RowArgs): DuoRailControlFrame {
  const size = DUO_RAIL_CONTROL_SIZE
  const column = statusColumn(args)
  const span = columnSpan(args, column)
  const left = controlLeft(clusterMidX(args, column), span, size)
  const fromTop = column !== null ? column.y <= 1 : args.strip.top > 1
  const occludedEdge = statusOcclusionEdge(args, column, fromTop)
  const top = fromTop ? occludedEdge + spacing.sm : occludedEdge - spacing.sm - size
  return { top, left, size }
}

function clusterMidX(args: RowArgs, column: ReservedRect | null): number {
  const mark = column === null ? null : statusGlyph(column, args.occlusions)
  if (mark !== null) {
    return mark.x + mark.width / 2
  }
  const onRight =
    column !== null
      ? column.x + column.width / 2 > args.windowWidth / 2
      : args.strip.side === 'right'
  return onRight ? args.windowWidth - STATUS_ROW_CENTER_FROM_EDGE : STATUS_ROW_CENTER_FROM_EDGE
}

function controlLeft(
  midX: number,
  span: { start: number; width: number },
  size: number
): number {
  const min = span.start
  const max = span.start + span.width - size
  return Math.min(Math.max(midX - size / 2, min), max)
}

function columnSpan(
  args: RowArgs,
  column: ReservedRect | null
): { start: number; width: number } {
  if (column !== null) {
    return { start: column.x, width: column.width }
  }
  if (args.strip.side === 'right') {
    return { start: args.windowWidth - args.strip.width, width: args.strip.width }
  }
  return { start: 0, width: args.strip.width }
}

function statusOcclusionEdge(args: RowArgs, column: ReservedRect | null, fromTop: boolean): number {
  if (column !== null) {
    return fromTop ? column.y + column.height : column.y
  }
  return fromTop ? args.strip.top : args.windowHeight - args.strip.bottom
}
