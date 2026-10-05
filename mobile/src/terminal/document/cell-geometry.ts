import { getCellHeight } from './fit-scale'
import { getCellWidth, getTotalScale } from './viewport-transform'
import type { TerminalDocumentScope } from './document-scope'

export function cellToViewportPx(scope: TerminalDocumentScope, col: number, absRow: number) {
  if (!scope.term) {
    return { x: 0, y: 0 }
  }
  const cellW = getCellWidth(scope)
  const cellH = getCellHeight(scope)
  const viewportRow = absRow - scope.term.buffer.active.viewportY
  const sx = col * cellW
  const sy = viewportRow * cellH
  const total = getTotalScale(scope)
  return { x: sx * total + scope.panX, y: sy * total + scope.panY }
}

export function getLineText(scope: TerminalDocumentScope, absRow: number) {
  if (!scope.term) {
    return ''
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return ''
  }
  return line.translateToString(false)
}

// Why: getLineText collapses wide chars (emoji, CJK) to one string char, so a
// tap's CELL column no longer equals the STRING index that url/path matchers use.
// Convert by measuring the string length up to the tapped cell (the count of
// string chars before it). Without this, taps on lines with a leading wide char
// (e.g. agent output prefixed with ⏺) resolve to the wrong column and miss.
export function cellColToStringIndex(scope: TerminalDocumentScope, absRow: number, col: number) {
  if (!scope.term) {
    return col
  }
  const line = scope.term.buffer.active.getLine(absRow)
  if (!line) {
    return col
  }
  return line.translateToString(false, 0, col).length
}

// File-path-under-tap detection (matchFilePathAtColumn). See path-tap.ts;
// mirrors the unit-tested terminal-path-tap.ts.
