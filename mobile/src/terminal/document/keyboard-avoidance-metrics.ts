import { getMeasuredCellHeight, getTotalScale } from './viewport-transform'
import { notify } from './host-notify'
import type {
  TerminalDocumentCell,
  TerminalDocumentLine,
  TerminalDocumentScope
} from './document-scope'

export function lineHasVisibleContent(
  scope: TerminalDocumentScope,
  line: TerminalDocumentLine,
  cell: TerminalDocumentCell | null
) {
  if (line.translateToString(true).trim().length > 0) {
    return true
  }
  if (!cell || !line.getCell) {
    return false
  }
  const limit = Math.min(scope.term!.cols || 0, line.length || 0)
  for (let x = 0; x < limit; x++) {
    const current = line.getCell(x, cell)
    if (!current) {
      continue
    }
    if (!current.isBgDefault() || current.isInverse()) {
      return true
    }
    if (typeof current.isUnderline === 'function' && current.isUnderline()) {
      return true
    }
    if (typeof current.isStrikethrough === 'function' && current.isStrikethrough()) {
      return true
    }
    if (typeof current.isOverline === 'function' && current.isOverline()) {
      return true
    }
  }
  return false
}

export function computeContentBottomRow(scope: TerminalDocumentScope) {
  if (!scope.term || !scope.term.buffer || !scope.term.buffer.active) {
    return 0
  }
  const buffer = scope.term.buffer.active
  const top = buffer.viewportY || 0
  const cell = buffer.getNullCell ? buffer.getNullCell() : null
  for (let y = (scope.term.rows || 0) - 1; y >= 0; y--) {
    try {
      const line = buffer.getLine(top + y)
      if (line && lineHasVisibleContent(scope, line, cell)) {
        return y
      }
    } catch {}
  }
  return 0
}

export function emitKeyboardAvoidanceMetrics(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  let alt = false
  try {
    alt =
      scope.term.buffer && scope.term.buffer.active && scope.term.buffer.active.type === 'alternate'
  } catch {}
  notify(scope, {
    type: 'keyboard-avoidance-metrics',
    cursorY: scope.term.buffer && scope.term.buffer.active ? scope.term.buffer.active.cursorY : 0,
    contentBottomRow: alt ? 0 : computeContentBottomRow(scope),
    rows: scope.term.rows || 0,
    altScreen: alt,
    // As drawn: desktop display mode scales the desktop's rows down to the phone's width.
    rowPitch: getMeasuredCellHeight(scope) * getTotalScale(scope)
  })
}
