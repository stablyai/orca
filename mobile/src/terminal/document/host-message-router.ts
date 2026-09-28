import type { TerminalDocumentScope } from './document-scope'
import { applyFitScale } from './fit-scale'
import { notify } from './host-notify'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { emitModesIfChanged } from './mode-mirroring'
import { reflow } from './reflow'
import { resumeTerminalDataReplyAuthority } from './query-reply'
import { repositionOverlay } from './selection-overlay'
import { cancelSelect } from './selection-range'
import { resetEvictionCounter } from './selection-state-and-eviction'
import { applyTerminalTheme } from './terminal-theme'
import { init, resize, write } from './terminal-init'
import { applyTextScale } from './text-scaling'
import { resetWriteQueue } from './write-queue'

/** One message from the host. Every field is optional because the router reads them by type. */
export type TerminalHostMessage = {
  id?: number
  type?: string
  cols?: number
  rows?: number
  initialData?: unknown
  terminalTheme?: Parameters<typeof applyTerminalTheme>[1]
  fontScale?: number
  preserveScroll?: boolean
  oscLinks?: unknown
  data?: string
  frame?: { width: number; height: number } | null
}

/** The frame React Native laid out, sent with every grid; null when absent or without a size. */
function hostFrameOf(msg: TerminalHostMessage) {
  const frame = msg.frame
  return frame && frame.width > 0 && frame.height > 0
    ? { width: frame.width, height: frame.height }
    : null
}

/** Keeps the frame a grid was fitted to, for a later text-scale change to fit. */
function holdHostFrame(scope: TerminalDocumentScope, msg: TerminalHostMessage) {
  scope.hostFrame = hostFrameOf(msg) ?? scope.hostFrame
}

export function handleMsg(scope: TerminalDocumentScope, msg: TerminalHostMessage) {
  if (typeof msg.id === 'number') {
    // oxlint-disable-next-line unicorn/prefer-includes -- the document's text is pinned token for token; rewriting this changes the native program
    if (scope.handledMessageIds.indexOf(msg.id) !== -1) {
      return
    }
    scope.handledMessageIds.push(msg.id)
    if (scope.handledMessageIds.length > 256) {
      scope.handledMessageIds.shift()
    }
  }
  if (msg.type === 'ping') {
    notify(scope, { type: 'pong', pingId: msg.id })
  } else if (msg.type === 'init') {
    holdHostFrame(scope, msg)
    init(
      scope,
      msg.cols!,
      msg.rows!,
      msg.initialData,
      msg.terminalTheme,
      msg.fontScale,
      msg.preserveScroll!,
      msg.oscLinks
    )
  } else if (msg.type === 'set-font-scale') {
    // Why: ignore RN echoing back the value a pinch just set (msg.fontScale ===
    // currentTextScale) so the post-pinch state isn't reset; only apply changes.
    if (
      typeof msg.fontScale === 'number' &&
      msg.fontScale > 0 &&
      msg.fontScale !== scope.currentTextScale
    ) {
      scope.userScale = 1
      scope.panX = 0
      scope.panY = 0
      applyTextScale(scope, msg.fontScale)
    }
  } else if (msg.type === 'resize') {
    holdHostFrame(scope, msg)
    resize(scope, msg.cols!, msg.rows!)
  } else if (msg.type === 'reflow') {
    holdHostFrame(scope, msg)
    reflow(scope, msg.cols!, msg.rows!)
  } else if (msg.type === 'write') {
    write(scope, msg.data!)
  } else if (msg.type === 'clear') {
    scope.terminalGeneration++
    resetWriteQueue(scope)
    resumeTerminalDataReplyAuthority(scope) // Why: clear drops the replay boundary.
    scope.statusDotPendingSelector = false
    scope.afterDrainCallbacks = []
    scope.writesDraining = false
    scope.mouseModeScanTail = ''
    scope.trackedMouseTrackingMode = 'none'
    scope.sgrMouseMode = false
    scope.sgrMousePixelsMode = false
    scope.initialOscLinks = []
    scope.initialOscLinkRowOffset = 0
    scope.initialOscLinkEvictionReady = false
    if (scope.term) {
      scope.term.clear()
      scope.term.reset()
    }
    emitModesIfChanged(scope)
    emitKeyboardAvoidanceMetrics(scope)
    resetEvictionCounter(scope)
    if (scope.selMode === 'select') {
      notify(scope, { type: 'selection-evicted' })
      cancelSelect(scope)
    }
  } else if (msg.type === 'reset-zoom') {
    applyFitScale(scope, 'reset-zoom-msg')
  } else if (msg.type === 'set-theme') {
    applyTerminalTheme(scope, msg.terminalTheme)
  } else if (msg.type === 'cancel-select') {
    if (scope.selMode === 'select') {
      cancelSelect(scope)
    }
  } else if (msg.type === 'do-select-all') {
    if (scope.term) {
      try {
        scope.term.selectAll()
        const b = scope.term.buffer.active
        if (scope.selMode !== 'select') {
          scope.selMode = 'select'
          scope.selectionOverlay!.classList.add('active')
          notify(scope, { type: 'set-select-mode', enabled: true })
        }
        scope.sel = {
          anchor: { col: 0, row: 0 },
          focus: { col: scope.term.cols - 1, row: b.length - 1 },
          activeHandle: null
        }
        repositionOverlay(scope)
      } catch {}
    }
  }
}
