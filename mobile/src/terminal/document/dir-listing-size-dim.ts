import { matchTrailingDirListingSize } from '../terminal-dir-listing-size-dim'
import { scheduleDocumentFrame } from './document-frame-registry'
import type { TerminalDocumentScope } from './document-scope'
import type {
  TerminalDocumentDecoration,
  TerminalDocumentLine
} from './document-terminal-shape'

// Visual-only dim of trailing directory-listing size tokens. The PTY buffer,
// selection, and copy stay byte-identical. Matcher source of truth is
// matchTrailingDirListingSize.

function stringIndexToCellCol(line: TerminalDocumentLine, stringIndex: number) {
  if (stringIndex <= 0) {
    return 0
  }
  let consumed = 0
  for (let col = 0; col < line.length; col++) {
    if (consumed >= stringIndex) {
      return col
    }
    const cell = line.getCell?.(col)
    if (!cell) {
      return col
    }
    const chars = cell.getChars?.()
    if (chars) {
      consumed += chars.length
    }
  }
  return line.length
}

export function clearSizeDimDecorations(scope: TerminalDocumentScope) {
  const decorations = scope.sizeDimDecorations
  if (!decorations || decorations.length === 0) {
    return
  }
  scope.sizeDimDecorations = []
  for (let i = 0; i < decorations.length; i++) {
    const decoration = decorations[i]!
    // IDecoration.dispose leaves the linked IMarker alive in the buffer.
    try {
      decoration.marker?.dispose()
    } catch {}
    try {
      decoration.dispose()
    } catch {}
  }
}

function refreshSizeDimDecorations(scope: TerminalDocumentScope) {
  scope.sizeDimRefreshScheduled = false
  clearSizeDimDecorations(scope)
  const term = scope.term
  if (
    !scope.dimDirListingSizesEnabled ||
    !term ||
    typeof term.registerMarker !== 'function' ||
    typeof term.registerDecoration !== 'function'
  ) {
    return
  }
  const buf = term.buffer.active
  const baseY = buf.baseY
  const cursorY = buf.cursorY
  // body.style.background is empty when the theme is only set via xterm options.
  const bg = scope.terminalTheme.background || scope.defaultTheme.background || '#1a1b26'
  for (let row = 0; row < term.rows; row++) {
    const line = buf.getLine(baseY + row)
    if (!line) {
      continue
    }
    const range = matchTrailingDirListingSize(line.translateToString(false))
    if (!range) {
      continue
    }
    const startCol = stringIndexToCellCol(line, range.start)
    const endCol = stringIndexToCellCol(line, range.end)
    const width = Math.max(1, endCol - startCol)
    let marker: { dispose: () => void } | undefined
    try {
      marker = term.registerMarker(row - cursorY)
    } catch {
      continue
    }
    if (!marker) {
      continue
    }
    let decoration: TerminalDocumentDecoration | undefined
    try {
      decoration = term.registerDecoration({
        marker,
        x: startCol,
        width,
        layer: 'top'
      })
    } catch {
      try {
        marker.dispose()
      } catch {}
      continue
    }
    if (!decoration) {
      try {
        marker.dispose()
      } catch {}
      continue
    }
    decoration.onRender(function (element) {
      element.style.background = bg
      element.style.opacity = '0.62'
      element.style.pointerEvents = 'none'
    })
    scope.sizeDimDecorations.push(decoration)
  }
}

export function scheduleSizeDimRefresh(scope: TerminalDocumentScope) {
  if (!scope.dimDirListingSizesEnabled || scope.sizeDimRefreshScheduled) {
    return
  }
  scope.sizeDimRefreshScheduled = true
  const id = scheduleDocumentFrame(scope, function () {
    refreshSizeDimDecorations(scope)
  })
  if (id === -1) {
    scope.sizeDimRefreshScheduled = false
  }
}

export function setDimDirListingSizes(scope: TerminalDocumentScope, enabled: boolean) {
  scope.dimDirListingSizesEnabled = !!enabled
  if (!scope.dimDirListingSizesEnabled) {
    scope.sizeDimRefreshScheduled = false
    clearSizeDimDecorations(scope)
    return
  }
  scheduleSizeDimRefresh(scope)
}
