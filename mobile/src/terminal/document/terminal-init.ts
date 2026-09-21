import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import {
  terminalCursorBlink,
  terminalCursorInactiveStyle,
  terminalCursorStyle,
  terminalShowCursorImmediately
} from './document-constants'
import { notify } from './host-notify'
import { fontPxForScale } from './text-scaling'
import { scope, scheduleDocumentFrame } from './document-scope'
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
  cols: number,
  rows: number,
  initialData: unknown,
  nextTheme: Parameters<typeof applyTerminalTheme>[0],
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
  resetTerminalDataReplyAuthority()
  cancelWebglContextRecovery()
  scope.webglAddon = null
  scope.ready = false
  resetWriteQueue()
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
  updateMouseModeFromData(replayData)
  scope.activeAltScreenSnapshot = isAltScreenActive(replayData)
  scope.initialOscLinks = Array.isArray(nextOscLinks) ? nextOscLinks : []
  scope.initialOscLinkRowOffset = 0
  scope.initialOscLinkEvictionReady = false
  const surfaceSwap = beginTerminalSurfaceSwap()
  // oxlint-disable-next-line no-unused-vars -- the document declares it here; removing it is a different program
  const nextSurface = surfaceSwap.nextSurface

  applyTerminalTheme(nextTheme)
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
    cursorBlink: terminalCursorBlink,
    cursorStyle: terminalCursorStyle,
    // Native TextInput owns focus; initialize xterm's otherwise-gated main-buffer caret.
    showCursorImmediately: terminalShowCursorImmediately,
    // A full inactive cell remains visible under the terminal's phone-fit scale.
    cursorInactiveStyle: terminalCursorInactiveStyle,
    convertEol: false,
    allowProposedApi: true
  })
  const nextTerm = scope.term
  scope.pendingTerm = nextTerm
  scope.term.open(scope.surface!)
  attachWebglAddon(true)
  try {
    const unicodeAddon = scope.createUnicode11Addon()
    if (unicodeAddon) {
      scope.term.loadAddon(unicodeAddon)
      scope.term.unicode.activeVersion = '11'
    }
  } catch {}
  if (typeof replayData === 'string' && replayData.length > 0) {
    // Why no trailing reset: the snapshot pen belongs to the live host TUI receiving later output.
    enqueueWrite(scope.ESC + '[0m' + replayData)
  }

  // Why: reset eviction tracking + attach observers for the new term.
  resetEvictionCounter()
  cancelSelect()
  attachTermObservers()
  attachTerminalQueryReplyBridge(scope.term, gen)

  scheduleDocumentFrame(function () {
    if (gen !== scope.terminalGeneration) {
      return
    }
    scope.ready = true
    scope.everReady = true
    afterWritesDrained(function () {
      if (gen !== scope.terminalGeneration) {
        return
      }
      commitTerminalSurfaceSwap(surfaceSwap, nextTerm)
      // Why: restore the reader's place after the rewrapped buffer replays.
      // Replay lands at bottom, so only act when they were scrolled up (rows>0).
      if (scrollAnchorRows > 0 && scope.term && scope.term.buffer && scope.term.buffer.active) {
        try {
          scope.term.scrollToLine(
            Math.max(0, (scope.term.buffer.active.baseY || 0) - scrollAnchorRows)
          )
        } catch {}
      }
      captureInitialOscLinkTexts()
      scope.initialOscLinkRowOffset = 0
      scope.initialOscLinkEvictionReady = true
      applyFitScale('init-replay')
      notify({ type: 'ready', cols: cols, rows: rows })
    })
  })
}

export function write(data: string) {
  updateMouseModeFromData(data)
  enqueueWrite(data)
  pumpWrites(scope.terminalGeneration)
  // Why: first live data chunk after init may widen the buffer past
  // what the post-replay applyFitScale measured. Re-fit once after this
  // chunk drains to catch the wider line. Subsequent chunks don't re-fit
  // (the user's manual zoom is sticky after that).
  if (scope.firstDataPending) {
    scope.firstDataPending = false
    const gen = scope.terminalGeneration
    afterWritesDrained(function () {
      if (gen !== scope.terminalGeneration) {
        return
      }
      applyFitScale('first-data')
    })
  }
}

export function resize(cols: number, rows: number) {
  if (!scope.term) {
    return
  }
  scope.initRows = rows || scope.initRows
  scope.term.resize(cols || scope.term.cols, rows || scope.term.rows)
  emitKeyboardAvoidanceMetrics()
  applyFitScale('resize-msg')
  notify({ type: 'ready', cols: cols, rows: rows })
}

// reflow(): see reflow.ts.

/**
 * Ruling 21: init's own frames carry the generation they were scheduled under, so bumping it is
 * what abandons them — the same guard a re-init already uses against its predecessor.
 */
export function stopTerminalInit() {
  scope.terminalGeneration++
}
