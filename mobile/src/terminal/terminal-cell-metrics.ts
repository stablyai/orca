/**
 * The document's cell box per text size, so a fit needs no terminal and no message round trip.
 *
 * The document reports a guessed table at `web-ready` (one entry per preset, because the text
 * scale only reaches it after that notify), then the box xterm actually lays out whenever it changes.
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
  const reported: unknown[] = msg.cellMetrics
  for (const entry of reported) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('fontScale' in entry && 'cellWidth' in entry && 'cellHeight' in entry)
    ) {
      continue
    }
    const fontScale = positive(entry.fontScale)
    const cellWidth = positive(entry.cellWidth)
    const cellHeight = positive(entry.cellHeight)
    if (fontScale !== null && cellWidth !== null && cellHeight !== null) {
      entries.push({ fontScale, cellWidth, cellHeight })
    }
  }
  return entries
}

/**
 * Absorbs floating-point error at an exact column or row boundary: CSS boxes come in device-pixel
 * steps, so a real quotient is an integer or at least ~1e-2 away from one, never within 1e-6.
 */
const FIT_BOUNDARY_EPSILON = 1e-6

/** The document's own measure, from numbers instead of a live terminal. */
export function fitDimensionsFromCell(
  cell: Pick<TerminalCellMetrics, 'cellWidth' | 'cellHeight'>,
  width: number,
  height: number
): TerminalFitDimensions | null {
  const cols = Math.floor(width / cell.cellWidth + FIT_BOUNDARY_EPSILON)
  if (cols < MIN_FIT_COLS) {
    return null
  }
  const rows = Math.floor(height / cell.cellHeight + FIT_BOUNDARY_EPSILON)
  return { cols, rows: Math.max(MIN_FIT_ROWS, rows) }
}

type Box = { width: number; height: number }

function readBox(width: unknown, height: unknown): Box | null {
  const w = positive(width)
  const h = positive(height)
  return w !== null && h !== null ? { width: w, height: h } : null
}

function sameCell(a: TerminalCellMetrics | undefined, b: TerminalCellMetrics) {
  return a !== undefined && a.cellWidth === b.cellWidth && a.cellHeight === b.cellHeight
}

export function createTerminalCellMetricsStore() {
  const cells = new Map<number, TerminalCellMetrics>()
  // Why: only the probe's guess is corrected; a DOM renderer re-derives its width from cols after
  // every re-init, and treating each of those as a correction can flip the fit between two sizes.
  const guessedScales = new Set<number>()
  // Why: RN reports the view's layout once per mount; a reloaded document must not replace it.
  let layoutBox: Box | null = null
  // The document's own viewport, which on the page arrives at web-ready before any RN layout.
  let documentBox: Box | null = null

  return {
    /** A new document: its probe table and viewport replace the last document's. */
    acceptWebReady(msg: Record<string, unknown>) {
      cells.clear()
      guessedScales.clear()
      for (const entry of readTerminalCellMetrics(msg)) {
        cells.set(entry.fontScale, entry)
        guessedScales.add(entry.fontScale)
      }
      documentBox = readBox(msg.viewportWidth, msg.viewportHeight)
    },
    /**
     * The box xterm laid out, which always updates the fit. Returns it only when it is the first
     * box for a guessed scale and differs from the guess: at most one correction per guess.
     */
    acceptLaidOut(msg: Record<string, unknown>): TerminalCellMetrics | null {
      const [actual] = readTerminalCellMetrics(msg)
      if (!actual) {
        return null
      }
      const guessed = guessedScales.delete(actual.fontScale)
        ? cells.get(actual.fontScale)
        : undefined
      cells.set(actual.fontScale, actual)
      // Why: with no guess the first subscribe went without dims, and the fit pass owns that case.
      return guessed === undefined || sameCell(guessed, actual) ? null : actual
    },
    layout(width: unknown, height: unknown) {
      layoutBox = readBox(width, height) ?? layoutBox
    },
    /**
     * Undefined when the table has no entry for this scale or no box is known yet, so the caller
     * can fall back to asking the document; null when the box is too small to fit.
     */
    fit(fontScale: number, containerHeight?: number): TerminalFitDimensions | null | undefined {
      const cell = cells.get(fontScale)
      const box = layoutBox ?? documentBox
      if (!cell || !box) {
        return undefined
      }
      const height = positive(containerHeight) ?? box.height
      return fitDimensionsFromCell(cell, box.width, height)
    },
    /** The document is gone; the view, and so its layout, is not. */
    clear() {
      cells.clear()
      guessedScales.clear()
      documentBox = null
    }
  }
}

export type TerminalCellMetricsStore = ReturnType<typeof createTerminalCellMetricsStore>
