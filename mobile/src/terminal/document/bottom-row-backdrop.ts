import { elementInRoot } from './document-host-seams'
import type { TerminalDocumentScope } from './document-scope'
import { getMeasuredCellHeight, getTotalScale } from './cell-metrics'

const DEFAULT_BACKGROUND = -1

/** Uniform last-row backgrounds; xterm keeps the live OSC 11 default on its element. */
export function lastRowBackground(scope: TerminalDocumentScope): string | null {
  const term = scope.term
  if (!term || !term.buffer || !term.buffer.active) {
    return null
  }
  const buffer = term.buffer.active
  const line = buffer.getLine((buffer.viewportY || 0) + term.rows - 1)
  const cell = buffer.getNullCell ? buffer.getNullCell() : null
  if (!line || !line.getCell || !cell) {
    return null
  }
  const limit = Math.min(term.cols || 0, line.length || 0)
  let shared: number | null = null
  for (let x = 0; x < limit; x++) {
    const current = line.getCell(x, cell)
    if (!current || current.isInverse()) {
      return null
    }
    let background: number
    if (current.isBgDefault()) {
      background = DEFAULT_BACKGROUND
    } else if (current.isBgRGB && current.isBgRGB() && current.getBgColor) {
      background = current.getBgColor()
    } else {
      return null
    }
    if (shared === null) {
      shared = background
    } else if (background !== shared) {
      return null
    }
  }
  if (shared === null) {
    return null
  }
  if (shared === DEFAULT_BACKGROUND) {
    return (term.element && term.element.style.backgroundColor) || scope.terminalTheme.background
  }
  return `rgb(${(shared >> 16) & 255}, ${(shared >> 8) & 255}, ${shared & 255})`
}

// Extend only the fractional row; larger gaps belong to the surrounding theme.
export function paintBottomRowBackdrop(scope: TerminalDocumentScope) {
  const container = elementInRoot(scope.root, 'terminal-container')
  if (!container) {
    return
  }
  let fill = ''
  if (scope.term) {
    const rowHeight = getMeasuredCellHeight(scope) * getTotalScale(scope)
    const gridBottom = scope.panY + scope.term.rows * rowHeight
    const strip = scope.viewportRect().height - gridBottom
    const color = strip > 0 && strip < rowHeight ? lastRowBackground(scope) : null
    if (color) {
      fill = `linear-gradient(to bottom, transparent ${gridBottom}px, ${color} ${gridBottom}px)`
    }
  }
  if (fill === scope.bottomRowBackdrop) {
    return
  }
  scope.bottomRowBackdrop = fill
  container.style.setProperty('--terminal-bottom-row-backdrop', fill || 'none')
}
