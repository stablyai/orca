import { parseTerminalKittyKeyboardFlags } from '../../../../src/shared/terminal-kitty-keyboard-flags'
import { resetSmoothScrollOffset } from './normal-buffer-smooth-scroll'
import { stopSurfaceTouchGestures } from './surface-touch-gestures'
import { clearLongPress } from './tap-dispatch'
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
import { attachOsc52ClipboardBridge } from './osc52-clipboard-bridge'
import {
  attachProgramStatusQueryReplies,
  attachTerminalQueryReplyBridge,
  resetTerminalDataReplyAuthority
} from './query-reply'
import { cancelSelect } from './selection-mode'
import { resetEvictionCounter } from './selection-state-and-eviction'
import { beginTerminalSurfaceSwap, commitTerminalSurfaceSwap } from './surface-swap'
import { attachTermObservers } from './term-observers'
import { applyTerminalTheme } from './terminal-theme'
import { attachWebglAddon, cancelWebglContextRecovery } from './webgl-recovery'
import { afterWritesDrained, enqueueWrite, pumpWrites, resetWriteQueue } from './write-queue'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../../../src/shared/terminal-scrollback-policy'
import { activateOrcaTerminalUnicodeProvider } from '../../../../src/shared/terminal-unicode-provider'

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
    scrollback: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    // Parser query replies need stdin enabled; native still validates their grammar.
    disableStdin: false,
    cursorBlink: MOBILE_TERMINAL_CARET_OPTIONS.cursorBlink,
    cursorStyle: MOBILE_TERMINAL_CARET_OPTIONS.cursorStyle,
    showCursorImmediately: MOBILE_TERMINAL_CARET_OPTIONS.showCursorImmediately,
    cursorInactiveStyle: MOBILE_TERMINAL_CARET_OPTIONS.cursorInactiveStyle,
    convertEol: false,
    allowProposedApi: true
  })
  scope.term = term
  attachOsc52ClipboardBridge(scope, term)
  attachProgramStatusQueryReplies(scope, term)
  term.open(scope.surface!)
  attachWebglAddon(scope, true)
  try {
    const unicodeAddon = scope.createUnicode11Addon()
    if (unicodeAddon) {
      term.loadAddon(unicodeAddon)
      activateOrcaTerminalUnicodeProvider(term)
    }
  } catch {}
  return term
}

// Build before ready to report measured cells at the app’s text scale; first init resizes and reuses the engine.
export function prepareTerminal(scope: TerminalDocumentScope) {
  // Measure without showing the temporary empty grid/caret.
  scope.surface!.style.visibility = 'hidden'
  try {
    scope.committedTerm = openTerminal(scope, 80, 24)
    scope.provisionalTerm = scope.committedTerm
  } catch {
    // Let init retry and report failure through its normal error path.
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
  nextOscLinks: unknown,
  kittyKeyboardFlags: unknown
) {
  // Replay replaces the scroll target; retire momentum and pending drags belonging to the old one.
  stopSurfaceTouchGestures(scope)
  resetSmoothScrollOffset(scope)
  clearLongPress(scope)
  scope.tapCandidate = null
  if (typeof nextFontScale === 'number' && nextFontScale > 0) {
    scope.currentTextScale = nextFontScale
  }
  // Use distance from bottom across width reflow because row counts/cell positions change; null remains bottom-pinned.
  const prevB =
    preserveScroll && scope.term && scope.term.buffer && scope.term.buffer.active
      ? scope.term.buffer.active
      : null
  // A hidden replay never moved what the reader sees, so one that overtakes it keeps its anchor.
  const supersededAnchorRows = scope.pendingTerm ? scope.pendingReplayScrollAnchorRows : null
  const scrollAnchorRows = !preserveScroll
    ? -1
    : (supersededAnchorRows ??
      (prevB ? Math.max(0, (prevB.baseY || 0) - (prevB.viewportY || 0)) : -1))
  scope.terminalGeneration++
  const gen = scope.terminalGeneration
  const reused = scope.provisionalTerm
  scope.provisionalTerm = null
  // Snapshot queries must never reach live PTY input; each replacement earns reply authority anew.
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
  // lastEmittedModes stays what native last received, so a cleared snapshot still publishes its modes.
  scope.keyboardModes.adoptSnapshot(
    typeof initialData === 'string' ? initialData : '',
    parseTerminalKittyKeyboardFlags(kittyKeyboardFlags)
  )
  const replayData = normalizeInitialData(initialData)
  // Mirror only replayed modes after normal-buffer prefixes are discarded.
  updateMouseModeFromData(scope, replayData)
  scope.activeAltScreenSnapshot = isAltScreenActive(replayData)
  scope.pendingReplayScrollAnchorRows = scope.activeAltScreenSnapshot ? null : scrollAnchorRows
  scope.initialOscLinks = Array.isArray(nextOscLinks) ? nextOscLinks : []
  scope.initialOscLinkRowOffset = 0
  scope.initialOscLinkEvictionReady = false
  // Pre-ready engines already occupy the committed surface; only replacements need hidden replay.
  const surfaceSwap = reused ? null : beginTerminalSurfaceSwap(scope)

  applyTerminalTheme(scope, nextTheme)
  let nextTerm: TerminalDocumentTerminal
  if (reused) {
    nextTerm = reused
    scope.term = reused
    reused.reset()
    reused.options.fontSize = fontPxForScale(scope.currentTextScale)
    reused.resize(cols || 80, rows || 24)
    // Seed the reported grid so its first box change can trigger one DOM-column refit.
    if (scope.reportedCellBox) {
      scope.reportedCellBox = { ...scope.reportedCellBox, cols: reused.cols, rows: reused.rows }
    }
  } else {
    nextTerm = openTerminal(scope, cols || 80, rows || 24)
    scope.pendingTerm = nextTerm
  }
  if (typeof replayData === 'string' && replayData.length > 0) {
    // Do not reset the pen after replay; later live output continues the host TUI’s attributes.
    enqueueWrite(scope, ESC + '[0m' + replayData)
  }

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
        scope.surface!.style.visibility = ''
      }
      // Replay lands at bottom; restore only readers who had scrolled upward before reflow.
      const anchorRows = scope.pendingReplayScrollAnchorRows ?? 0
      if (anchorRows > 0 && scope.term && scope.term.buffer && scope.term.buffer.active) {
        try {
          scope.term.scrollToLine(Math.max(0, (scope.term.buffer.active.baseY || 0) - anchorRows))
        } catch {}
      }
      captureInitialOscLinkTexts(scope)
      scope.initialOscLinkRowOffset = 0
      scope.initialOscLinkEvictionReady = true
      applyFitScale(scope, 'init-replay')
      // Hidden renderers may not paint yet; report the available box at ready too.
      reportLaidOutCellBox(scope)
      notify(scope, { type: 'ready', cols: cols, rows: rows })
    })
  })
}

export function write(scope: TerminalDocumentScope, data: string) {
  updateMouseModeFromData(scope, data, true)
  scope.keyboardModes.scan(data)
  enqueueWrite(scope, data)
  pumpWrites(scope, scope.terminalGeneration)
  // Refit once after first live output reveals a wider line; later chunks preserve manual zoom.
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

// Invalidate queued init frames by generation and dispose both committed and pending-swap engines, deduping identical instances.
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
