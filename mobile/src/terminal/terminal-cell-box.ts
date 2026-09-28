/**
 * The cell box xterm laid out in one document, so the first subscribe after ready carries the phone's dims.
 *
 * The document builds its terminal before it reports ready, puts that box in `web-ready`, and
 * reports it again whenever xterm lays out a different one.
 */
export type TerminalCellBox = { fontScale: number; cellWidth: number; cellHeight: number }

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** The notify's `cellBox` when well formed; null when absent or malformed. */
export function readTerminalCellBox(msg: Record<string, unknown>): TerminalCellBox | null {
  const box = msg.cellBox
  if (
    typeof box !== 'object' ||
    box === null ||
    !('fontScale' in box && 'cellWidth' in box && 'cellHeight' in box)
  ) {
    return null
  }
  const fontScale = positive(box.fontScale)
  const cellWidth = positive(box.cellWidth)
  const cellHeight = positive(box.cellHeight)
  return fontScale !== null && cellWidth !== null && cellHeight !== null
    ? { fontScale, cellWidth, cellHeight }
    : null
}
