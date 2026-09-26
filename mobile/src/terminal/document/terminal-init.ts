import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { MOBILE_TERMINAL_CARET_OPTIONS } from '../terminal-webview-html/theme'
import { ESC } from './escape-introducers'
import { notify } from './host-notify'
import { laidOutCellMetrics } from './cell-metrics-probe'
import { fontPxForScale } from './text-scaling'
import type { TerminalDocumentScope } from './document-scope'
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
  // Why: snapshot replay can contain old queries whose replies must never
  // re-enter the live PTY. Each replacement terminal earns authority anew.
  resetTerminalDataReplyAuthority(scope)
  cancelWebglContextRecovery(scope)
  scope.webglAddon = null
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
  const surfaceSwap = beginTerminalSurfaceSwap(scope)
  // oxlint-disable-next-line no-unused-vars -- the document declares it here; removing it is a different program
  const nextSurface = surfaceSwap.nextSurface

  applyTerminalTheme(scope, nextTheme)
  scope.term = scope.createTerminal({
    cols: cols || 80,
    rows: rows || 24,
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
  const nextTerm = scope.term
  scope.pendingTerm = nextTerm
  scope.term.open(scope.surface!)
  attachWebglAddon(scope, true)
  try {
    const unicodeAddon = scope.createUnicode11Addon()
    if (unicodeAddon) {
      scope.term.loadAddon(unicodeAddon)
      scope.term.unicode.activeVersion = '11'
    }
  } catch {}
  if (typeof replayData === 'string' && replayData.length > 0) {
    // Why no trailing reset: the snapshot pen belongs to the live host TUI receiving later output.
    enqueueWrite(scope, ESC + '[0m' + replayData)
  }

  // Why: reset eviction tracking + attach observers for the new term.
  resetEvictionCounter(scope)
  cancelSelect(scope)
  attachTermObservers(scope)
  attachTerminalQueryReplyBridge(scope, scope.term, gen)

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
      commitTerminalSurfaceSwap(scope, surfaceSwap, nextTerm)
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
      notify(scope, {
        type: 'ready',
        cols: cols,
        rows: rows,
        cellMetrics: laidOutCellMetrics(scope)
      })
    })
  })
}

export function write(scope: TerminalDocumentScope, data: string) {
  updateMouseModeFromData(scope, data)
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
  notify(scope, { type: 'ready', cols: cols, rows: rows })
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
}
