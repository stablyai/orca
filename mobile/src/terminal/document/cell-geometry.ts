import type { TerminalDocumentScope } from './document-scope'

/** 0 until the renderer has measured a cell. */
export function getMeasuredCellHeight(scope: TerminalDocumentScope) {
  const core = scope.term?._core
  if (core && core._renderService && core._renderService.dimensions) {
    return core._renderService.dimensions.css.cell.height || 0
  }
  return 0
}

export function getCellWidth(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.term._core) {
    return 0
  }
  const core = scope.term._core
  if (core._renderService && core._renderService.dimensions) {
    return core._renderService.dimensions.css.cell.width || 0
  }
  return 0
}

export function getTotalScale(scope: TerminalDocumentScope) {
  return scope.currentScale * scope.userScale
}

export function getCellHeight(scope: TerminalDocumentScope) {
  return getMeasuredCellHeight(scope) || 15
}

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
