import type { TerminalCellBox } from '../terminal-cell-box'
import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import { fontPxForScale } from './text-scaling'

/** The box xterm actually laid out, for the scale it was opened at; null before one. */
export function laidOutCellBox(scope: TerminalDocumentScope): TerminalCellBox | null {
  const core = scope.term && scope.term._core
  const dimensions = core && core._renderService && core._renderService.dimensions
  if (!dimensions || !scope.term) {
    return null
  }
  const { width, height } = dimensions.css.cell
  if (!(width > 0 && height > 0)) {
    return null
  }
  // A text-size change between init and ready leaves a box that belongs to neither scale.
  if (scope.term.options.fontSize !== fontPxForScale(scope.currentTextScale)) {
    return null
  }
  return { fontScale: scope.currentTextScale, cellWidth: width, cellHeight: height }
}

/**
 * Tells the host the box xterm laid out whenever it or the grid changes: after init, a renderer
 * swap on context loss, a text-size or DPR change, or a resize (the DOM renderer's width depends on
 * cols). A new grid is reported with an unchanged box too, so the host holds the grid in place
 * when a later renderer swap arrives at it.
 */
export function reportLaidOutCellBox(scope: TerminalDocumentScope) {
  const laidOut = laidOutCellBox(scope)
  if (!laidOut || !scope.term) {
    return
  }
  const { cols, rows } = scope.term
  const key = `${laidOut.fontScale}:${laidOut.cellWidth}x${laidOut.cellHeight}@${cols}x${rows}`
  if (key === scope.reportedCellBox) {
    return
  }
  scope.reportedCellBox = key
  notify(scope, {
    type: 'cell-metrics',
    cellBox: laidOut,
    cols,
    rows
  })
}
