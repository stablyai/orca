import { handleDragMove, stopEdgeScroll } from './selection-overlay'
import { cancelSelect, enterSelect } from './selection-mode'
import { notify } from './host-notify'
import { viewportToCell } from './viewport-cell'
import type { TerminalDocumentScope } from './document-scope'
import { queuedNormalBufferScrollReachesRow } from './normal-buffer-smooth-scroll'
import { notifyTerminalSurfaceTap } from './surface-tap'
import {
  eventTargetInRoot,
  touchesInRoot,
  type TerminalDocumentTargetContainer
} from './document-host-seams'

const LONG_PRESS_MS = 500

const LONG_PRESS_SLOP = 10

export const TAP_SLOP = 24

const TAP_MAX_MS = 700

export type TerminalTouchDispatch = {
  mode: string
  touchId: number | null
  touchIds: number[] | null
  longPressFingerInsideOverlay: boolean
}

export function touchById(touches: ArrayLike<Touch>, id: number | null) {
  for (let i = 0; i < touches.length; i++) {
    if (touches[i].identifier === id) {
      return touches[i]
    }
  }
  return null
}

export function targetInside(
  target: EventTarget | null,
  el: TerminalDocumentTargetContainer | null
) {
  if (!target || !el) {
    return false
  }
  return el.contains(target)
}

export function clearLongPress(scope: TerminalDocumentScope) {
  if (scope.longPressTimer) {
    clearTimeout(scope.longPressTimer)
    scope.longPressTimer = null
  }
  scope.longPressOrigin = null
}

export function armLongPress(scope: TerminalDocumentScope, touch: Touch) {
  scope.longPressOrigin = { x: touch.clientX, y: touch.clientY, identifier: touch.identifier }
  scope.longPressTimer = setTimeout(function () {
    scope.longPressTimer = null
    if (!scope.longPressOrigin) {
      return
    }
    const c = viewportToCell(scope, scope.longPressOrigin.x, scope.longPressOrigin.y)
    if (!c) {
      return
    }
    enterSelect(scope, c.col, c.row)
    // Keep the long-press finger on its selection instead of scrolling underneath.
    if (scope.sel && scope.touchDispatch.mode === 'surface') {
      scope.sel.activeHandle = 'end'
      scope.touchDispatch.mode = 'select-drag'
      scope.touchDispatch.touchId = scope.longPressOrigin.identifier
      scope.tapCandidate = null
    }
  }, LONG_PRESS_MS)
}

export function touchSlopExceeded(scope: TerminalDocumentScope, t: Touch) {
  if (!scope.longPressOrigin) {
    return false
  }
  const dx = Math.abs(t.clientX - scope.longPressOrigin.x)
  const dy = Math.abs(t.clientY - scope.longPressOrigin.y)
  return dx + dy > LONG_PRESS_SLOP
}

// Suppress surface handlers while document dispatch owns a selection-handle drag.
export function dispatcherShouldBlockSurface(scope: TerminalDocumentScope) {
  return !scope.interactionActive || scope.touchDispatch.mode === 'select-drag'
}

// Use identical capture options for listener registration and removal.
const CAPTURE_ACTIVE = { capture: true, passive: false }
const CAPTURE_PASSIVE = { capture: true, passive: true }

// Touch targets stay at their start element, so owned drags still belong here after crossing the host edge.
function touchIsThisDocuments(scope: TerminalDocumentScope, e: { target: EventTarget | null }) {
  return scope.interactionActive && eventTargetInRoot(scope.root, e.target)
}

function onDocumentTouchStart(scope: TerminalDocumentScope, e: TouchEvent) {
  if (!touchIsThisDocuments(scope, e)) {
    return
  }
  const touches = touchesInRoot(scope.root, e.touches)
  const t = touches[0]
  const target = e.target
  const onHandle = target === scope.handleStart || target === scope.handleEnd
  const inOverlay = targetInside(target, scope.selectionOverlay)
  const inSurface = targetInside(target, scope.surface)
  // Only fresh single-finger surface touches can arm taps; clear stale candidates before handle drags, pinches or dismissals.
  scope.tapCandidate = null

  if (touches.length === 2) {
    if (scope.selMode === 'select') {
      notify(scope, { type: 'mobile-clip-cancel-by-pinch' })
      cancelSelect(scope)
    }
    scope.touchDispatch.mode = 'pinch'
    scope.touchDispatch.touchIds = [touches[0].identifier, touches[1].identifier]
    clearLongPress(scope)
    return
  }

  if (onHandle && scope.selMode === 'select') {
    const handleName = target === scope.handleStart ? 'start' : 'end'
    scope.sel!.activeHandle = handleName
    scope.touchDispatch.mode = 'select-drag'
    scope.touchDispatch.touchId = t.identifier
    e.preventDefault()
    return
  }

  if (inOverlay) {
    return
  }

  if (inSurface && scope.selMode === 'select') {
    // Dismiss selection immediately but let the same gesture scroll/pan without requiring another touch.
    cancelSelect(scope)
    scope.touchDispatch.mode = 'surface'
    scope.touchDispatch.touchId = t.identifier
    return
  }

  if (inSurface) {
    scope.touchDispatch.mode = 'surface'
    scope.touchDispatch.touchId = t.identifier
    scope.tapCandidate = { x: t.clientX, y: t.clientY, t: Date.now(), identifier: t.identifier }
    armLongPress(scope, t)
  }
}

function onDocumentTouchMove(scope: TerminalDocumentScope, e: TouchEvent) {
  if (!touchIsThisDocuments(scope, e)) {
    return
  }
  const touches = touchesInRoot(scope.root, e.touches)
  if (scope.touchDispatch.mode === 'select-drag') {
    const t = touchById(touches, scope.touchDispatch.touchId)
    if (!t || !scope.sel || !scope.sel.activeHandle) {
      return
    }
    e.preventDefault()
    handleDragMove(scope, scope.sel.activeHandle, t.clientX, t.clientY)
    return
  }
  if (scope.touchDispatch.mode === 'surface' || scope.touchDispatch.mode === 'pinch') {
    if (scope.longPressTimer && touches.length === 1) {
      if (touchSlopExceeded(scope, touches[0])) {
        clearLongPress(scope)
      }
    }
    // Disqualify taps independently of long-press slop so short jitter still opens the touched link/path.
    if (scope.tapCandidate && touches.length === 1) {
      const mt = touches[0]
      if (mt.identifier === scope.tapCandidate.identifier) {
        const dx = Math.abs(mt.clientX - scope.tapCandidate.x)
        const dy = Math.abs(mt.clientY - scope.tapCandidate.y)
        if (dx + dy > TAP_SLOP) {
          scope.tapCandidate = null
        }
      }
    } else if (touches.length !== 1) {
      scope.tapCandidate = null
    }
  }
}

function onDocumentTouchEnd(scope: TerminalDocumentScope, e: TouchEvent) {
  if (!touchIsThisDocuments(scope, e)) {
    return
  }
  const touches = touchesInRoot(scope.root, e.touches)
  if (scope.touchDispatch.mode === 'select-drag') {
    if (scope.sel) {
      scope.sel.activeHandle = null
    }
    stopEdgeScroll(scope)
    scope.touchDispatch.mode = 'idle'
    scope.touchDispatch.touchId = null
    return
  }
  if (scope.touchDispatch.mode === 'pinch') {
    if (touches.length < 2) {
      scope.touchDispatch.mode = touches.length === 1 ? 'surface' : 'idle'
      scope.touchDispatch.touchIds = null
      if (touches.length === 1) {
        scope.touchDispatch.touchId = touches[0].identifier
      }
    }
    return
  }
  if (scope.touchDispatch.mode === 'surface') {
    // Use the tap candidate’s origin; long-press origin may be cleared by harmless finger jitter.
    if (
      touches.length === 0 &&
      scope.tapCandidate &&
      scope.selMode !== 'select' &&
      Date.now() - scope.tapCandidate.t <= TAP_MAX_MS &&
      // Release can precede a queued row-scroll frame; cancelled-out movement remains a tap.
      !queuedNormalBufferScrollReachesRow(scope)
    ) {
      notifyTerminalSurfaceTap(scope, scope.tapCandidate.x, scope.tapCandidate.y, true)
    }
    clearLongPress(scope)
    scope.tapCandidate = null
    if (touches.length === 0) {
      scope.touchDispatch.mode = 'idle'
      scope.touchDispatch.touchId = null
    }
  }
}

function onDocumentTouchCancel(scope: TerminalDocumentScope, e: TouchEvent) {
  if (!touchIsThisDocuments(scope, e)) {
    return
  }
  clearLongPress(scope)
  scope.tapCandidate = null
  stopEdgeScroll(scope)
  if (scope.touchDispatch.mode === 'select-drag') {
    if (scope.sel) {
      scope.sel.activeHandle = null
    }
  }
  scope.touchDispatch.mode = 'idle'
  scope.touchDispatch.touchId = null
  scope.touchDispatch.touchIds = null
}

// Document listeners outlive replaced host elements; install and undo them per mount.
export function startTapDispatch(scope: TerminalDocumentScope) {
  const start = (e: TouchEvent) => onDocumentTouchStart(scope, e)
  const move = (e: TouchEvent) => onDocumentTouchMove(scope, e)
  const end = (e: TouchEvent) => onDocumentTouchEnd(scope, e)
  const cancel = (e: TouchEvent) => onDocumentTouchCancel(scope, e)
  document.addEventListener('touchstart', start, CAPTURE_ACTIVE)
  document.addEventListener('touchmove', move, CAPTURE_ACTIVE)
  document.addEventListener('touchend', end, CAPTURE_PASSIVE)
  document.addEventListener('touchcancel', cancel, CAPTURE_PASSIVE)
  // Retain remover closures because removeEventListener matches each scope’s exact callback identity.
  scope.removeTapDispatch = () => {
    document.removeEventListener('touchstart', start, CAPTURE_ACTIVE)
    document.removeEventListener('touchmove', move, CAPTURE_ACTIVE)
    document.removeEventListener('touchend', end, CAPTURE_PASSIVE)
    document.removeEventListener('touchcancel', cancel, CAPTURE_PASSIVE)
  }
}

export function stopTapDispatch(scope: TerminalDocumentScope) {
  if (scope.removeTapDispatch) {
    scope.removeTapDispatch()
    scope.removeTapDispatch = null
  }
  clearLongPress(scope)
}
