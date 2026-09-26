/**
 * The document's cell box per text size, so a fit needs no terminal and no message round trip.
 *
 * The document reports a table at `web-ready` (one entry per preset, because the text scale only
 * reaches it after that notify) and the box xterm actually laid out at each init's `ready`.
 */

export type TerminalCellMetrics = { fontScale: number; cellWidth: number; cellHeight: number }

export type TerminalFitDimensions = { cols: number; rows: number }

/** Below these the fit is not a terminal anyone can read, and the caller disables fit-to-phone. */
export const MIN_FIT_COLS = 20
export const MIN_FIT_ROWS = 8

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** The notify's `cellMetrics`, keeping only well-formed entries; absent on an older document. */
export function readTerminalCellMetrics(msg: Record<string, unknown>): TerminalCellMetrics[] {
  if (!Array.isArray(msg.cellMetrics)) {
    return []
  }
  const entries: TerminalCellMetrics[] = []
  for (const entry of msg.cellMetrics) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const fontScale = positive(Reflect.get(entry, 'fontScale'))
    const cellWidth = positive(Reflect.get(entry, 'cellWidth'))
    const cellHeight = positive(Reflect.get(entry, 'cellHeight'))
    if (fontScale !== null && cellWidth !== null && cellHeight !== null) {
      entries.push({ fontScale, cellWidth, cellHeight })
    }
  }
  return entries
}

/** The document's own measure, from numbers instead of a live terminal. */
export function fitDimensionsFromCell(
  cell: Pick<TerminalCellMetrics, 'cellWidth' | 'cellHeight'>,
  width: number,
  height: number
): TerminalFitDimensions | null {
  const cols = Math.floor(width / cell.cellWidth)
  if (cols < MIN_FIT_COLS) {
    return null
  }
  return { cols, rows: Math.max(MIN_FIT_ROWS, Math.floor(height / cell.cellHeight)) }
}

export function createTerminalCellMetricsStore() {
  const cells = new Map<number, TerminalCellMetrics>()
  let box: { width: number; height: number } | null = null

  function setBox(width: unknown, height: unknown) {
    const w = positive(width)
    const h = positive(height)
    if (w !== null && h !== null) {
      box = { width: w, height: h }
    }
  }

  return {
    /** A new document: its table and its viewport replace everything the last one said. */
    acceptWebReady(msg: Record<string, unknown>) {
      cells.clear()
      box = null
      for (const entry of readTerminalCellMetrics(msg)) {
        cells.set(entry.fontScale, entry)
      }
      setBox(msg.viewportWidth, msg.viewportHeight)
    },
    /** xterm's own box after an init; returns what it replaced so a mismatch can be logged. */
    acceptReady(msg: Record<string, unknown>) {
      const [actual] = readTerminalCellMetrics(msg)
      if (!actual) {
        return null
      }
      const reported = cells.get(actual.fontScale) ?? null
      cells.set(actual.fontScale, actual)
      return { reported, actual }
    },
    /** The terminal view's RN layout, which is current after the document's own report. */
    layout: setBox,
    /**
     * Undefined when the table has no entry for this scale or no box is known yet, so the caller
     * can fall back to asking the document; null when the box is too small to fit.
     */
    fit(fontScale: number, containerHeight?: number): TerminalFitDimensions | null | undefined {
      const cell = cells.get(fontScale)
      if (!cell || !box) {
        return undefined
      }
      const height = positive(containerHeight) ?? box.height
      return fitDimensionsFromCell(cell, box.width, height)
    },
    clear() {
      cells.clear()
      box = null
    }
  }
}

export type TerminalCellMetricsStore = ReturnType<typeof createTerminalCellMetricsStore>
