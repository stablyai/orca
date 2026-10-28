import { getCellHeight, getCellWidth, getTotalScale } from './cell-metrics'
import { cellToViewportPx } from './cell-geometry'
import { elementInRoot } from './document-host-seams'
import type { TerminalDocumentScope } from './document-scope'
import { fontPxForScale } from './text-scaling'

// Unconfirmed guesses vanish after this; a lost or rewritten echo must not leave ghost text.
const LOCAL_ECHO_TIMEOUT_MS = 1500

const DEL = '\x7f'

// Narrow single-cell glyphs only (ASCII, Latin, Greek, Cyrillic); wide or combining text waits for the host.
function isPredictable(ch: string) {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x20 && code < 0x7f) ||
    (code >= 0xa0 && code < 0x0300) ||
    (code >= 0x0370 && code < 0x0530)
  )
}

function cursorCell(scope: TerminalDocumentScope) {
  const buffer = scope.term!.buffer.active
  return { col: buffer.cursorX ?? 0, row: buffer.baseY + buffer.cursorY }
}

export function resetLocalEcho(scope: TerminalDocumentScope) {
  if (!scope.localEchoAnchor && !scope.localEchoTimer) {
    return
  }
  scope.localEchoPending = []
  scope.localEchoTimes = []
  scope.localEchoAnchor = null
  if (scope.localEchoTimer) {
    clearTimeout(scope.localEchoTimer)
    scope.localEchoTimer = null
  }
  paintLocalEcho(scope)
}

// Replaced content (init, resize, reflow, clear) may put a no-echo prompt on a row trusted before it.
export function forgetLocalEcho(scope: TerminalDocumentScope) {
  scope.localEchoTrustedRow = null
  resetLocalEcho(scope)
}

// Trust is a row number, which means nothing in the other buffer (vim exits to a shell sudo prompt).
function syncLocalEchoBuffer(scope: TerminalDocumentScope) {
  const type = scope.term!.buffer.active.type
  if (scope.localEchoBufferType !== type) {
    scope.localEchoBufferType = type
    forgetLocalEcho(scope)
  }
}

// Expire by the oldest pending guess; restarting per keystroke would keep an unechoed first char on screen.
function armTimeout(scope: TerminalDocumentScope) {
  if (scope.localEchoTimer) {
    clearTimeout(scope.localEchoTimer)
  }
  const oldest = scope.localEchoTimes[0] ?? Date.now()
  scope.localEchoTimer = setTimeout(
    function () {
      scope.localEchoTimer = null
      // A missed echo may be a no-echo password prompt; show nothing until echo is seen again.
      forgetLocalEcho(scope)
    },
    Math.max(0, oldest + LOCAL_ECHO_TIMEOUT_MS - Date.now())
  )
}

// Draw typed text at the cursor before the host echo arrives; the xterm buffer is never touched.
export function predictLocalEcho(scope: TerminalDocumentScope, data: string) {
  // Alternate screen is allowed: Orca's Claude Code runs there (device readout, 2026-10-27), and the
  // trust rule keeps vim-style command keys hidden because they never echo at the cursor.
  if (!scope.term) {
    return resetLocalEcho(scope)
  }
  syncLocalEchoBuffer(scope)
  const chars = Array.from(data)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === DEL && scope.localEchoPending.length > 0) {
      scope.localEchoPending.pop()
      scope.localEchoTimes.pop()
      continue
    }
    // Erasing already-echoed text or any control byte moves the cursor in ways only the host knows.
    if (!isPredictable(ch)) {
      // Enter or a control key may open a no-echo prompt on this same row; re-earn trust per line.
      return forgetLocalEcho(scope)
    }
    if (scope.localEchoPending.length === 0) {
      scope.localEchoAnchor = cursorCell(scope)
    }
    // Wrapping is the TUI's call (Claude Code reflows its input box), so stop at the line end.
    if (scope.localEchoAnchor!.col + scope.localEchoPending.length >= scope.term.cols - 1) {
      break
    }
    scope.localEchoPending.push(ch)
    scope.localEchoTimes.push(Date.now())
  }
  if (scope.localEchoPending.length > 0) {
    armTimeout(scope)
  }
  paintLocalEcho(scope)
}

// A guess is confirmed once its cell holds the same char and the host cursor has moved past it.
export function reconcileLocalEcho(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  syncLocalEchoBuffer(scope)
  const anchor = scope.localEchoAnchor
  if (!anchor || scope.localEchoPending.length === 0) {
    return
  }
  const buffer = scope.term.buffer.active
  const cursor = cursorCell(scope)
  const line = buffer.getLine(anchor.row)
  let confirmed = 0
  while (confirmed < scope.localEchoPending.length) {
    const col = anchor.col + confirmed
    const cursorPast = cursor.row > anchor.row || (cursor.row === anchor.row && cursor.col > col)
    if (
      !line ||
      !cursorPast ||
      line.translateToString(false, col, col + 1) !== scope.localEchoPending[confirmed]
    ) {
      break
    }
    confirmed++
  }
  if (confirmed > 0) {
    scope.localEchoTrustedRow = anchor.row
    scope.localEchoPending = scope.localEchoPending.slice(confirmed)
    scope.localEchoTimes = scope.localEchoTimes.slice(confirmed)
    anchor.col += confirmed
    if (scope.localEchoPending.length === 0) {
      return resetLocalEcho(scope)
    }
    armTimeout(scope)
  }
  paintLocalEcho(scope)
}

export function paintLocalEcho(scope: TerminalDocumentScope) {
  const layer = elementInRoot(scope.root, 'local-echo')
  if (!layer) {
    return
  }
  layer.textContent = ''
  const anchor = scope.localEchoAnchor
  if (!scope.term || !anchor || scope.localEchoPending.length === 0) {
    return
  }
  // Only rows where the host has echoed a guess are shown, so a new no-echo prompt never displays secrets.
  if (scope.localEchoTrustedRow !== anchor.row) {
    return
  }
  // Mid-frame TUI redraws park the cursor elsewhere; hide until it is back where the guesses start.
  const cursor = cursorCell(scope)
  if (cursor.row !== anchor.row || cursor.col !== anchor.col) {
    return
  }
  const total = getTotalScale(scope)
  const cellW = getCellWidth(scope) * total
  const cellH = getCellHeight(scope) * total
  const fontSize = fontPxForScale(scope.currentTextScale) * total + 'px'
  // One span per cell so glyph advances cannot drift from xterm's measured grid.
  for (let i = 0; i < scope.localEchoPending.length; i++) {
    const origin = cellToViewportPx(scope, anchor.col + i, anchor.row)
    const span = document.createElement('span')
    span.textContent = scope.localEchoPending[i]
    span.style.left = origin.x + 'px'
    span.style.top = origin.y + 'px'
    span.style.width = cellW + 'px'
    span.style.height = cellH + 'px'
    span.style.lineHeight = cellH + 'px'
    span.style.fontFamily = scope.terminalFontFamily
    span.style.fontSize = fontSize
    span.style.color = scope.terminalTheme.foreground || ''
    span.style.background = scope.terminalTheme.background || ''
    layer.appendChild(span)
  }
}
