import { elementInRoot } from './document-host-seams'
import type { TerminalDocumentScope } from './document-scope'
import { getCellHeight } from './fit-scale'
import { getTotalScale } from './viewport-transform'

const DEFAULT_BACKGROUND = -1

/**
 * The last visible row's colour when every cell shares one. Default cells follow OSC 11 through the
 * background xterm keeps on its element.
 */
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
  return (
    'rgb(' + ((shared >> 16) & 255) + ', ' + ((shared >> 8) & 255) + ', ' + (shared & 255) + ')'
  )
}

// Why: the PTY gets whole rows, so up to a row of frame sits under the grid, and the theme colour
// there reads as a band under a program that paints its own background. A taller gap (a
// desktop-sized grid) is empty space rather than part of the last row, and keeps the theme.
export function paintBottomRowBackdrop(scope: TerminalDocumentScope) {
  const container = elementInRoot(scope.root, 'terminal-container')
  if (!container) {
    return
  }
  let fill = ''
  if (scope.term) {
    const rowHeight = getCellHeight(scope) * getTotalScale(scope)
    const gridBottom = scope.panY + scope.term.rows * rowHeight
    const strip = scope.viewportRect().height - gridBottom
    const color = strip > 0 && strip < rowHeight ? lastRowBackground(scope) : null
    if (color) {
      fill =
        'linear-gradient(to bottom, transparent ' +
        gridBottom +
        'px, ' +
        color +
        ' ' +
        gridBottom +
        'px)'
    }
  }
  if (fill === scope.bottomRowBackdrop) {
    return
  }
  scope.bottomRowBackdrop = fill
  container.style.backgroundImage = fill
}
