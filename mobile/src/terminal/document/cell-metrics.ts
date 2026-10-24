import type { TerminalDocumentScope } from './document-scope'

// Why: a leaf of pure reads, so fit, transform and overlay modules can share them without a cycle.

// xterm's RenderService.dimensions getter reads this._renderer.value.dimensions without
// guarding for a disposed or not-yet-installed renderer, throwing TypeError when accessed
// after term.dispose() or before a renderer is attached.
export function readRenderDimensions(scope: TerminalDocumentScope) {
  const renderService = scope.term?._core?._renderService
  if (!renderService) {
    return null
  }
  if (typeof renderService.hasRenderer === 'function' && !renderService.hasRenderer()) {
    return null
  }
  try {
    return renderService.dimensions ?? null
  } catch {
    return null
  }
}

/** 0 until the renderer has measured a cell. */
export function getMeasuredCellHeight(scope: TerminalDocumentScope) {
  const dimensions = readRenderDimensions(scope)
  if (dimensions) {
    return dimensions.css.cell.height || 0
  }
  return 0
}

export function getCellHeight(scope: TerminalDocumentScope) {
  return getMeasuredCellHeight(scope) || 15
}

export function getCellWidth(scope: TerminalDocumentScope) {
  const dimensions = readRenderDimensions(scope)
  if (dimensions) {
    return dimensions.css.cell.width || 0
  }
  return 0
}

export function getTotalScale(scope: TerminalDocumentScope) {
  return scope.currentScale * scope.userScale
}
