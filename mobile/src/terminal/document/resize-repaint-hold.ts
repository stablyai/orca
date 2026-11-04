import { elementInRoot } from './document-host-seams'
import { isAlternateBufferActive } from './mouse-input-encoding'
import { afterWritesDrained } from './write-queue'
import type { TerminalDocumentScope } from './document-scope'

export type TerminalResizeHoldState = {
  canvas: HTMLCanvasElement
  settleTimer: ReturnType<typeof setTimeout> | null
  maxTimer: ReturnType<typeof setTimeout> | null
  startedAt: number
  deadlineAt: number
  lastWriteAt: number
  sawWrite: boolean
  wasAtBottom: boolean
}

const RESIZE_HOLD_INITIAL_WAIT_MS = 90
const RESIZE_HOLD_POST_DRAIN_SETTLE_MS = 36
const RESIZE_HOLD_MAX_MS = 260
const RESIZE_HOLD_STREAM_GAP_MS = 60
const RESIZE_HOLD_ABSOLUTE_MAX_MS = 1200

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

function isAtBottom(scope: TerminalDocumentScope): boolean {
  if (!scope.term || isAlternateBufferActive(scope)) {
    return false
  }
  const active = scope.term.buffer?.active
  if (!active) {
    return false
  }
  return (active.viewportY || 0) >= (active.baseY || 0)
}

function clearResizeHoldTimers(hold: TerminalResizeHoldState) {
  if (hold.settleTimer !== null) {
    clearTimeout(hold.settleTimer)
    hold.settleTimer = null
  }
  if (hold.maxTimer !== null) {
    clearTimeout(hold.maxTimer)
    hold.maxTimer = null
  }
}

function armResizeHoldMaxTimer(scope: TerminalDocumentScope, hold: TerminalResizeHoldState) {
  if (hold.maxTimer !== null) {
    clearTimeout(hold.maxTimer)
    hold.maxTimer = null
  }
  const waitMs = Math.max(0, hold.deadlineAt - monotonicNow())
  hold.maxTimer = setTimeout(function () {
    if (scope.resizeHold === hold) {
      hold.maxTimer = null
      releaseResizeRepaintSurface(scope, true)
    }
  }, waitMs)
}

export function releaseResizeRepaintSurface(scope: TerminalDocumentScope, restoreScroll = true) {
  const hold = scope.resizeHold
  if (!hold) {
    return
  }
  scope.resizeHold = null
  clearResizeHoldTimers(hold)
  const shouldScrollBottom = restoreScroll && hold.sawWrite && hold.wasAtBottom
  if (shouldScrollBottom && scope.term && !isAlternateBufferActive(scope)) {
    try {
      scope.term.scrollToBottom()
    } catch {}
  }
  if (scope.committedSurface) {
    scope.committedSurface.style.opacity = ''
  }
  try {
    hold.canvas.remove()
  } catch {}
}

function armResizeHoldSettle(scope: TerminalDocumentScope, delayMs: number) {
  const hold = scope.resizeHold
  if (!hold) {
    return
  }
  if (hold.settleTimer !== null) {
    clearTimeout(hold.settleTimer)
    hold.settleTimer = null
  }
  const remaining = Math.max(0, hold.deadlineAt - monotonicNow())
  const waitMs = Math.min(delayMs, remaining)
  if (waitMs <= 0) {
    releaseResizeRepaintSurface(scope, true)
    return
  }
  hold.settleTimer = setTimeout(function () {
    if (scope.resizeHold === hold) {
      hold.settleTimer = null
      releaseResizeRepaintSurface(scope, true)
    }
  }, waitMs)
}

export function holdResizeRepaintSurface(scope: TerminalDocumentScope) {
  const surface = scope.committedSurface
  if (!surface || scope.pendingSurface) {
    return
  }
  if (scope.resizeHold) {
    if (!scope.writesDraining) {
      armResizeHoldSettle(scope, RESIZE_HOLD_INITIAL_WAIT_MS)
    }
    return
  }
  const container = elementInRoot(scope.root, 'terminal-container')
  if (!container) {
    return
  }
  const rect = surface.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return
  }
  const canvases = surface.querySelectorAll('canvas')
  if (!canvases || canvases.length === 0) {
    return
  }
  const overlay = document.createElement('canvas')
  const ctx = overlay.getContext('2d')
  if (!ctx) {
    return
  }
  const firstCanvas = canvases[0]
  overlay.width = firstCanvas.width || Math.round(rect.width)
  overlay.height = firstCanvas.height || Math.round(rect.height)
  if (overlay.width <= 0 || overlay.height <= 0) {
    return
  }
  try {
    for (let i = 0; i < canvases.length; i++) {
      const src = canvases[i]
      if (src.width > 0 && src.height > 0) {
        ctx.drawImage(src, 0, 0, overlay.width, overlay.height)
      }
    }
  } catch {
    return
  }
  overlay.setAttribute('data-resize-repaint-hold', 'true')
  overlay.setAttribute('aria-hidden', 'true')
  overlay.style.position = 'absolute'
  overlay.style.left = '0'
  overlay.style.top = '0'
  overlay.style.width = rect.width + 'px'
  overlay.style.height = rect.height + 'px'
  overlay.style.pointerEvents = 'none'

  const startedAt = monotonicNow()
  const hold: TerminalResizeHoldState = {
    canvas: overlay,
    settleTimer: null,
    maxTimer: null,
    startedAt,
    deadlineAt: startedAt + RESIZE_HOLD_MAX_MS,
    lastWriteAt: Number.NEGATIVE_INFINITY,
    sawWrite: false,
    wasAtBottom: isAtBottom(scope)
  }
  scope.resizeHold = hold
  container.appendChild(overlay)
  surface.style.opacity = '0'

  armResizeHoldMaxTimer(scope, hold)
  armResizeHoldSettle(scope, RESIZE_HOLD_INITIAL_WAIT_MS)
}

export function noteResizeRepaintWrite(scope: TerminalDocumentScope) {
  const hold = scope.resizeHold
  if (!hold) {
    return
  }
  const now = monotonicNow()
  if (!hold.sawWrite || now - hold.lastWriteAt <= RESIZE_HOLD_STREAM_GAP_MS) {
    const extendedDeadline = Math.min(
      hold.startedAt + RESIZE_HOLD_ABSOLUTE_MAX_MS,
      Math.max(hold.deadlineAt, now + RESIZE_HOLD_MAX_MS)
    )
    if (extendedDeadline > hold.deadlineAt) {
      hold.deadlineAt = extendedDeadline
      armResizeHoldMaxTimer(scope, hold)
    }
  }
  hold.lastWriteAt = now
  hold.sawWrite = true
  if (hold.settleTimer !== null) {
    clearTimeout(hold.settleTimer)
    hold.settleTimer = null
  }
  const gen = scope.terminalGeneration
  afterWritesDrained(scope, function () {
    if (gen !== scope.terminalGeneration || scope.resizeHold !== hold) {
      return
    }
    armResizeHoldSettle(scope, RESIZE_HOLD_POST_DRAIN_SETTLE_MS)
  })
}
