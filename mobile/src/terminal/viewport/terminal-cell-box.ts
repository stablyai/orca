// Report xterm’s measured box at ready so the first subscription uses phone dimensions.
export type TerminalCellBox = { fontScale: number; cellWidth: number; cellHeight: number }

export type TerminalLaidOutCellBox = { cellBox: TerminalCellBox; cols: number; rows: number }

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

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

export function sameCellBox(a: TerminalCellBox, b: TerminalCellBox): boolean {
  return a.fontScale === b.fontScale && a.cellWidth === b.cellWidth && a.cellHeight === b.cellHeight
}
