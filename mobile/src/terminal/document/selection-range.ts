import { getLineText } from './cell-geometry'
import type { TerminalDocumentScope, TerminalDocumentSelection } from './document-scope'
import type { TerminalDocumentLine } from './document-terminal-shape'

/** What counts as one word for select-all and for word seeding. */
const WORD_RE = /[\p{L}\p{N}_./:@~+=?&#%-]/u

type SelectionUnit = { text: string; start: number; end: number }

function selectionUnits(line: TerminalDocumentLine, cols: number): SelectionUnit[] | null {
  const cells: SelectionUnit[] = []
  for (let col = 0; col < Math.min(cols, line.length);) {
    const cell = line.getCell?.(col)
    if (!cell?.getChars || !cell.getWidth) {
      return null
    }
    const width = cell.getWidth()
    if (width <= 0) {
      col++
      continue
    }
    cells.push({ text: cell.getChars() || ' ', start: col, end: col + width - 1 })
    col += width
  }
  if (typeof Intl.Segmenter !== 'function') {
    return cells
  }
  // A grapheme can occupy several xterm cells; UTF-16 length is never its cell width.
  const columns = cells.flatMap((cell) => Array.from({ length: cell.text.length }, () => cell))
  const text = cells.map((cell) => cell.text).join('')
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    (part) => ({
      text: part.segment,
      start: columns[part.index].start,
      end: columns[part.index + part.segment.length - 1].end
    })
  )
}

function wordCellRange(line: TerminalDocumentLine | undefined, col: number, cols: number) {
  const units = line && selectionUnits(line, cols)
  const index = units?.findIndex((unit) => unit.start <= col && col <= unit.end) ?? -1
  if (!units || index < 0) {
    return null
  }
  let start = index
  let end = index
  if (WORD_RE.test(units[index].text)) {
    while (start > 0 && WORD_RE.test(units[start - 1].text)) {
      start--
    }
    while (end + 1 < units.length && WORD_RE.test(units[end + 1].text)) {
      end++
    }
  }
  return { start: units[start].start, end: units[end].end }
}

/** The ordered ends of the selection, whichever way the user dragged it. */
export type TerminalSelectionRange = {
  start: TerminalDocumentSelection['anchor']
  end: TerminalDocumentSelection['anchor']
}

export function seedWordSelection(scope: TerminalDocumentScope, col: number, absRow: number) {
  const cells = wordCellRange(scope.term?.buffer.active.getLine(absRow), col, scope.term?.cols ?? 0)
  if (cells) {
    scope.sel = {
      anchor: { col: cells.start, row: absRow },
      focus: { col: cells.end, row: absRow },
      activeHandle: null
    }
    applyXtermSelection(scope)
    return
  }
  // Small host/test seams can expose text only; keep their existing ASCII behavior.
  const line = getLineText(scope, absRow)
  if (!line) {
    scope.sel = {
      anchor: { col: col, row: absRow },
      focus: { col: col, row: absRow },
      activeHandle: null
    }
    applyXtermSelection(scope)
    return
  }
  let s = col
  let e = col
  if (col >= 0 && col < line.length && WORD_RE.test(line[col])) {
    while (s > 0 && WORD_RE.test(line[s - 1])) {
      s--
    }
    while (e < line.length - 1 && WORD_RE.test(line[e + 1])) {
      e++
    }
  }
  scope.sel = {
    anchor: { col: s, row: absRow },
    focus: { col: e, row: absRow },
    activeHandle: null
  }
  applyXtermSelection(scope)
}

export function isStartFirst(
  a: TerminalDocumentSelection['anchor'],
  b: TerminalDocumentSelection['anchor']
) {
  if (a.row !== b.row) {
    return a.row < b.row
  }
  return a.col <= b.col
}

export function selRange(scope: TerminalDocumentScope): TerminalSelectionRange | null {
  if (!scope.sel) {
    return null
  }
  if (isStartFirst(scope.sel.anchor, scope.sel.focus)) {
    return { start: scope.sel.anchor, end: scope.sel.focus }
  }
  return { start: scope.sel.focus, end: scope.sel.anchor }
}

export function applyXtermSelection(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.sel) {
    return
  }
  const r = selRange(scope)
  if (!r) {
    return
  }
  // Why: term.select(col, row, length) takes a buffer-absolute row,
  // not a viewport-relative one. Subtracting viewportY here drifts the
  // selection by the scrollback height — handles render where the user
  // pressed (their math is independent), but xterm highlights an
  // off-screen scrollback region and copies the wrong text.
  let length: number
  if (r.start.row === r.end.row) {
    length = Math.max(1, r.end.col - r.start.col + 1)
  } else {
    const first = scope.term.cols - r.start.col
    const middle = Math.max(0, r.end.row - r.start.row - 1) * scope.term.cols
    const last = r.end.col + 1
    length = first + middle + last
  }
  try {
    scope.term.select(r.start.col, r.start.row, length)
  } catch {}
}
