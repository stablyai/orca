import { handleDragMove, stopEdgeScroll } from './selection-overlay'
import { cancelSelect, enterSelect } from './selection-range'
import { notify } from './host-notify'
import { viewportToCell } from './viewport-cell'
import type { TerminalDocumentScope } from './document-scope'
import { notifyTerminalSurfaceTap } from './surface-tap'
import {
  eventTargetInRoot,
  touchesInRoot,
  type TerminalDocumentTargetContainer
} from './document-host-seams'

/** The press duration that starts a selection, in milliseconds. */
const LONG_PRESS_MS = 500

/** The travel that cancels a pending long press, in pixels. */
const LONG_PRESS_SLOP = 10

/** The travel that disqualifies a tap, in pixels; the mouse drag path holds itself to the same. */
export const TAP_SLOP = 24

/** The longest press still counted as a tap, in milliseconds. */
const TAP_MAX_MS = 700

// ============================================================
// LATCHING TOUCH DISPATCHER (document-level)
// ============================================================

/** What the dispatcher has latched onto, and the fingers it is tracking. */
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

// Why: existing surface handlers stay attached to surface but we wrap
// their entry to no-op when the dispatcher latches into select-drag.
export function dispatcherShouldBlockSurface(scope: TerminalDocumentScope) {
  return scope.touchDispatch.mode === 'select-drag'
}

/**
 * The options each document handler is registered with, named so `stopTapDispatch` takes it off
 * with the identical `capture` flag it went on with.
 */
const CAPTURE_ACTIVE = { capture: true, passive: false }
const CAPTURE_PASSIVE = { capture: true, passive: true }

/**
 * Whether a touch belongs to this document (ruling 22's last page-wide read).
 *
 * `e.target` is the element the finger went down on and stays that element for the life of the
 * touch, so a select-drag that travels outside the host still answers yes on move and end.
 */
function touchIsThisDocuments(scope: TerminalDocumentScope, e: { target: EventTarget | null }) {
  return eventTargetInRoot(scope.root, e.target)
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
  // Why: clear any stale tap candidate up front; only a fresh single-finger
  // surface touch (below) re-arms it, so handle drags / pinches / dismiss
  // taps never resolve as a link tap on touchend.
  scope.tapCandidate = null

  if (touches.length === 2) {
    // pinch latch
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
    // start handle drag
    const handleName = target === scope.handleStart ? 'start' : 'end'
    scope.sel!.activeHandle = handleName
    scope.touchDispatch.mode = 'select-drag'
    scope.touchDispatch.touchId = t.identifier
    e.preventDefault()
    return
  }

  if (inOverlay) {
    // tap on menu pill — let the buttons' own handlers fire
    return
  }

  if (inSurface && scope.selMode === 'select') {
    // Why: tap-to-dismiss matches native iOS/Android — touching outside the
    // selection clears it. We cancel immediately and latch to 'surface' so
    // the same gesture still drives scroll/pan without a second touch.
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
    // long-press slop check
    if (scope.longPressTimer && touches.length === 1) {
      if (touchSlopExceeded(scope, touches[0])) {
        clearLongPress(scope)
      }
    }
    // Why: disqualify the tap only once the finger travels past TAP_SLOP
    // (a scroll/pan), independent of the long-press timer — so a tap that
    // jitters under TAP_SLOP still opens the link/path under the finger.
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
    // existing surface handler will run from its own listener
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
    // Why: fire the tap from the tap-candidate origin (survives jitter under
    // TAP_SLOP) rather than longPressOrigin, which the press-to-select slop
    // can null mid-tap — that was dropping URL/file taps that moved a few px.
    if (
      touches.length === 0 &&
      scope.tapCandidate &&
      scope.selMode !== 'select' &&
      Date.now() - scope.tapCandidate.t <= TAP_MAX_MS
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

/**
 * The dispatcher's four document listeners, per mount (ruling 20).
 *
 * They are on `document` rather than on the surface, so unlike every surface handler they outlive
 * the host element a remount replaces — which is exactly why the undo below exists.
 */
export function startTapDispatch(scope: TerminalDocumentScope) {
  const start = (e: TouchEvent) => onDocumentTouchStart(scope, e)
  const move = (e: TouchEvent) => onDocumentTouchMove(scope, e)
  const end = (e: TouchEvent) => onDocumentTouchEnd(scope, e)
  const cancel = (e: TouchEvent) => onDocumentTouchCancel(scope, e)
  document.addEventListener('touchstart', start, CAPTURE_ACTIVE)
  document.addEventListener('touchmove', move, CAPTURE_ACTIVE)
  document.addEventListener('touchend', end, CAPTURE_PASSIVE)
  document.addEventListener('touchcancel', cancel, CAPTURE_PASSIVE)
  // The removers, kept because the listeners are closures over this document's scope: identity is
  // what `removeEventListener` matches on, and a second document's are not these.
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
