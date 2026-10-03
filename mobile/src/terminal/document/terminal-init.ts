import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { MOBILE_TERMINAL_CARET_OPTIONS } from '../terminal-webview-html/theme'
import { ESC } from './escape-introducers'
import { notify } from './host-notify'
import { reportLaidOutCellBox } from './laid-out-cell-box'
import { fontPxForScale } from './text-scaling'
import type { TerminalDocumentScope, TerminalDocumentTerminal } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'
import { applyFitScale } from './fit-scale'
import {
  isAltScreenActive,
  normalizeInitialData,
  updateMouseModeFromData
} from './mouse-mode-decset-scan'
import { captureInitialOscLinkTexts } from './osc-link-tap'
import { attachTerminalQueryReplyBridge, resetTerminalDataReplyAuthority } from './query-reply'
import { cancelSelect } from './selection-range'
import { resetEvictionCounter } from './selection-state-and-eviction'
import { beginTerminalSurfaceSwap, commitTerminalSurfaceSwap } from './surface-swap'
import { attachTermObservers } from './term-observers'
import { applyTerminalTheme } from './terminal-theme'
import { attachWebglAddon, cancelWebglContextRecovery } from './webgl-recovery'
import { afterWritesDrained, enqueueWrite, pumpWrites, resetWriteQueue } from './write-queue'

/** Builds and opens a terminal on the current surface, with the renderer and addons attached. */
function openTerminal(scope: TerminalDocumentScope, cols: number, rows: number) {
  const term = scope.createTerminal({
    cols: cols,
    rows: rows,
    theme: scope.terminalTheme,
    minimumContrastRatio: scope.terminalMinimumContrastRatio,
    fontFamily: scope.terminalFontFamily,
    fontSize: fontPxForScale(scope.currentTextScale),
    fontWeight: '300',
    fontWeightBold: '500',
    scrollback: 5000,
    // Why: xterm suppresses parser-generated query replies when disableStdin
    // is true. Native accepts only validated reply grammars from onData.
    disableStdin: false,
    cursorBlink: MOBILE_TERMINAL_CARET_OPTIONS.cursorBlink,
    cursorStyle: MOBILE_TERMINAL_CARET_OPTIONS.cursorStyle,
    // Native TextInput owns focus; initialize xterm's otherwise-gated main-buffer caret.
    showCursorImmediately: MOBILE_TERMINAL_CARET_OPTIONS.showCursorImmediately,
    // A full inactive cell remains visible under the terminal's phone-fit scale.
    cursorInactiveStyle: MOBILE_TERMINAL_CARET_OPTIONS.cursorInactiveStyle,
    convertEol: false,
    allowProposedApi: true
  })
  scope.term = term
  term.open(scope.surface!)
  attachWebglAddon(scope, true)
  try {
    const unicodeAddon = scope.createUnicode11Addon()
    if (unicodeAddon) {
      term.loadAddon(unicodeAddon)
      term.unicode.activeVersion = '11'
    }
  } catch {}
  return term
}

/**
 * The document's terminal, built before it reports ready so ready can carry the cell box xterm
 * lays out at the app's text scale. Any size will do: the first init resizes and reuses it.
 */
export function prepareTerminal(scope: TerminalDocumentScope) {
  // Why: laid out for the measure, but not shown — an empty 80x24 grid and caret until init.
  scope.surface!.style.visibility = 'hidden'
  try {
    scope.committedTerm = openTerminal(scope, 80, 24)
    scope.provisionalTerm = scope.committedTerm
  } catch {
    // Why: init builds again and reports the failure through the path every init failure takes.
    scope.surface!.style.visibility = ''
    try {
      scope.term?.dispose()
    } catch {}
    scope.term = null
  }
}

export function init(
  scope: TerminalDocumentScope,
  cols: number,
  rows: number,
  initialData: unknown,
  nextTheme: Parameters<typeof applyTerminalTheme>[1],
  nextFontScale: unknown,
  preserveScroll: boolean,
  nextOscLinks: unknown
) {
  if (typeof nextFontScale === 'number' && nextFontScale > 0) {
    scope.currentTextScale = nextFontScale
  }
  // Why: a width-reflow re-stream rewraps the same content at new cols.
  // Distance-from-bottom (rows) is the only stable anchor across reflow,
  // since line counts and cell positions change. null = stay pinned to bottom.
  const prevB =
    preserveScroll && scope.term && scope.term.buffer && scope.term.buffer.active
      ? scope.term.buffer.active
      : null
  const scrollAnchorRows = prevB ? Math.max(0, (prevB.baseY || 0) - (prevB.viewportY || 0)) : -1
  scope.terminalGeneration++
  const gen = scope.terminalGeneration
  const reused = scope.provisionalTerm
  scope.provisionalTerm = null
  // Why: snapshot replay can contain old queries whose replies must never
  // re-enter the live PTY. Each replacement terminal earns authority anew.
  resetTerminalDataReplyAuthority(scope)
  if (!reused) {
    cancelWebglContextRecovery(scope)
    scope.webglAddon = null
  }
  scope.ready = false
  resetWriteQueue(scope)
  scope.statusDotPendingSelector = false
  scope.writesDraining = false
  scope.afterDrainCallbacks = []
  scope.initRows = rows || 24
  scope.firstDataPending = true
  scope.smoothScrollOffsetY = 0
  scope.wheelAccumDeltaY = 0
  scope.mouseModeScanTail = ''
  scope.trackedMouseTrackingMode = 'none'
  scope.mouseEncodingKnown = false
  scope.sgrMouseMode = false
  scope.sgrMousePixelsMode = false
  scope.lastEmittedModes = {
    bracketedPasteMode: false,
    altScreen: false,
    mouseTrackingMode: 'none',
    sgrMouseMode: false,
    sgrMousePixelsMode: false
  }
  const replayData = normalizeInitialData(initialData)
  // Why: normalizeInitialData can discard pre-alt-screen bytes. Keep the
  // mirrored modes aligned with exactly what this mobile xterm replays.
  updateMouseModeFromData(scope, replayData)
  scope.activeAltScreenSnapshot = isAltScreenActive(replayData)
  scope.initialOscLinks = Array.isArray(nextOscLinks) ? nextOscLinks : []
  scope.initialOscLinkRowOffset = 0
  scope.initialOscLinkEvictionReady = false
  // Why: the terminal built before ready is on the committed surface already; only a
  // replacement needs a hidden surface to replay into.
  const surfaceSwap = reused ? null : beginTerminalSurfaceSwap(scope)

  applyTerminalTheme(scope, nextTheme)
  let nextTerm: TerminalDocumentTerminal
  if (reused) {
    nextTerm = reused
    scope.term = reused
    reused.reset()
    reused.options.fontSize = fontPxForScale(scope.currentTextScale)
    reused.resize(cols || 80, rows || 24)
    // Why: its box was laid out at 80x24; the first report at this grid must read as the box
    // changing at a kept grid, which the DOM renderer's cols-dependent box then refits once.
    if (scope.reportedCellBox) {
      scope.reportedCellBox = { ...scope.reportedCellBox, cols: reused.cols, rows: reused.rows }
    }
  } else {
    nextTerm = openTerminal(scope, cols || 80, rows || 24)
    scope.pendingTerm = nextTerm
  }
  if (typeof replayData === 'string' && replayData.length > 0) {
    // Why no trailing reset: the snapshot pen belongs to the live host TUI receiving later output.
    enqueueWrite(scope, ESC + '[0m' + replayData)
  }

  // Why: reset eviction tracking + attach observers for the new term.
  resetEvictionCounter(scope)
  cancelSelect(scope)
  attachTermObservers(scope)
  attachTerminalQueryReplyBridge(scope, nextTerm, gen)

  scheduleDocumentFrame(scope, function () {
    if (gen !== scope.terminalGeneration) {
      return
    }
    scope.ready = true
    scope.everReady = true
    afterWritesDrained(scope, function () {
      if (gen !== scope.terminalGeneration) {
        return
      }
      if (surfaceSwap) {
        commitTerminalSurfaceSwap(scope, surfaceSwap, nextTerm)
      } else {
        // The terminal built before ready, shown now that it holds the replay.
        scope.surface!.style.visibility = ''
      }
      // Why: restore the reader's place after the rewrapped buffer replays.
      // Replay lands at bottom, so only act when they were scrolled up (rows>0).
      if (scrollAnchorRows > 0 && scope.term && scope.term.buffer && scope.term.buffer.active) {
        try {
          scope.term.scrollToLine(
            Math.max(0, (scope.term.buffer.active.baseY || 0) - scrollAnchorRows)
          )
        } catch {}
      }
      captureInitialOscLinkTexts(scope)
      scope.initialOscLinkRowOffset = 0
      scope.initialOscLinkEvictionReady = true
      applyFitScale(scope, 'init-replay')
      // Why: a paused (hidden) render service has not rendered yet, so ready reports it too.
      reportLaidOutCellBox(scope)
      // Why: labelled because only this ready follows a committed paint; the app reveals on it.
      notify(scope, { type: 'ready', source: 'init', cols: cols, rows: rows })
    })
  })
}

export function write(scope: TerminalDocumentScope, data: string) {
  updateMouseModeFromData(scope, data, true)
  enqueueWrite(scope, data)
  pumpWrites(scope, scope.terminalGeneration)
  // Why: first live data chunk after init may widen the buffer past
  // what the post-replay applyFitScale measured. Re-fit once after this
  // chunk drains to catch the wider line. Subsequent chunks don't re-fit
  // (the user's manual zoom is sticky after that).
  if (scope.firstDataPending) {
    scope.firstDataPending = false
    const gen = scope.terminalGeneration
    afterWritesDrained(scope, function () {
      if (gen !== scope.terminalGeneration) {
        return
      }
      applyFitScale(scope, 'first-data')
    })
  }
}

export function resize(scope: TerminalDocumentScope, cols: number, rows: number) {
  if (!scope.term) {
    return
  }
  scope.initRows = rows || scope.initRows
  scope.term.resize(cols || scope.term.cols, rows || scope.term.rows)
  emitKeyboardAvoidanceMetrics(scope)
  applyFitScale(scope, 'resize-msg')
  notify(scope, { type: 'ready', source: 'resize', cols: cols, rows: rows })
}

// reflow(): see reflow.ts.

/**
 * Ruling 21: init's own frames carry the generation they were scheduled under, so bumping it is
 * what abandons them — the same guard a re-init already uses against its predecessor.
 *
 * The engine goes too, because a stopped document's terminal is a WebGL context and a row buffer
 * that nothing will read again. Both terminals, since a swap that never committed leaves two:
 * `beginTerminalSurfaceSwap` opens a hidden replacement and `commitTerminalSurfaceSwap` disposes
 * the one it replaced, so a stop in between leaves the committed one live with nothing pointing at
 * it. They are the same object whenever no swap is open, which is what the set deduplicates.
 */
export function stopTerminalInit(scope: TerminalDocumentScope) {
  scope.terminalGeneration++
  for (const terminal of new Set([scope.term, scope.committedTerm])) {
    try {
      terminal?.dispose()
    } catch {}
  }
  scope.term = null
  scope.committedTerm = null
  scope.provisionalTerm = null
}
