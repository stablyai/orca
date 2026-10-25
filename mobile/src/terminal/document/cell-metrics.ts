import type { TerminalDocumentScope } from './document-scope'

// Keep pure metrics below fit/transform/overlay dependencies to avoid cycles.

export function getMeasuredCellHeight(scope: TerminalDocumentScope) {
  const core = scope.term?._core
  if (core && core._renderService && core._renderService.dimensions) {
    return core._renderService.dimensions.css.cell.height || 0
  }
  return 0
}

export function getCellHeight(scope: TerminalDocumentScope) {
  return getMeasuredCellHeight(scope) || 15
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
