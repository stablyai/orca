import { handleDragMove, stopEdgeScroll } from './selection-overlay'
import { cancelSelect, enterSelect } from './selection-range'
import { notify } from './host-notify'
import { viewportToCell } from './viewport-cell'
import { scope } from './document-scope'
import { notifyTerminalSurfaceTap } from './surface-tap'
import {
  eventTargetInRoot,
  touchesInRoot,
  type TerminalDocumentTargetContainer
} from './document-host-seams'

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

export function clearLongPress() {
  if (scope.longPressTimer) {
    clearTimeout(scope.longPressTimer)
    scope.longPressTimer = null
  }
  scope.longPressOrigin = null
}

export function armLongPress(touch: Touch) {
  scope.longPressOrigin = { x: touch.clientX, y: touch.clientY, identifier: touch.identifier }
  scope.longPressTimer = setTimeout(function () {
    scope.longPressTimer = null
    if (!scope.longPressOrigin) {
      return
    }
    const c = viewportToCell(scope.longPressOrigin.x, scope.longPressOrigin.y)
    if (!c) {
      return
    }
    enterSelect(c.col, c.row)
  }, scope.LONG_PRESS_MS)
}

export function touchSlopExceeded(t: Touch) {
  if (!scope.longPressOrigin) {
    return false
  }
  const dx = Math.abs(t.clientX - scope.longPressOrigin.x)
  const dy = Math.abs(t.clientY - scope.longPressOrigin.y)
  return dx + dy > scope.LONG_PRESS_SLOP
}

// Why: existing surface handlers stay attached to surface but we wrap
// their entry to no-op when the dispatcher latches into select-drag.
export function dispatcherShouldBlockSurface() {
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
function touchIsThisDocuments(e: { target: EventTarget | null }) {
  return eventTargetInRoot(scope.root, e.target)
}

function onDocumentTouchStart(e: TouchEvent) {
  if (!touchIsThisDocuments(e)) {
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
      notify({ type: 'mobile-clip-cancel-by-pinch' })
      cancelSelect()
    }
    scope.touchDispatch.mode = 'pinch'
    scope.touchDispatch.touchIds = [touches[0].identifier, touches[1].identifier]
    clearLongPress()
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
    cancelSelect()
    scope.touchDispatch.mode = 'surface'
    scope.touchDispatch.touchId = t.identifier
    return
  }

  if (inSurface) {
    scope.touchDispatch.mode = 'surface'
    scope.touchDispatch.touchId = t.identifier
    scope.tapCandidate = { x: t.clientX, y: t.clientY, t: Date.now(), identifier: t.identifier }
    armLongPress(t)
  }
}

function onDocumentTouchMove(e: TouchEvent) {
  if (!touchIsThisDocuments(e)) {
    return
  }
  const touches = touchesInRoot(scope.root, e.touches)
  if (scope.touchDispatch.mode === 'select-drag') {
    const t = touchById(touches, scope.touchDispatch.touchId)
    if (!t || !scope.sel || !scope.sel.activeHandle) {
      return
    }
    e.preventDefault()
    handleDragMove(scope.sel.activeHandle, t.clientX, t.clientY)
    return
  }
  if (scope.touchDispatch.mode === 'surface' || scope.touchDispatch.mode === 'pinch') {
    // long-press slop check
    if (scope.longPressTimer && touches.length === 1) {
      if (touchSlopExceeded(touches[0])) {
        clearLongPress()
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
        if (dx + dy > scope.TAP_SLOP) {
          scope.tapCandidate = null
        }
      }
    } else if (touches.length !== 1) {
      scope.tapCandidate = null
    }
    // existing surface handler will run from its own listener
  }
}

function onDocumentTouchEnd(e: TouchEvent) {
  if (!touchIsThisDocuments(e)) {
    return
  }
  const touches = touchesInRoot(scope.root, e.touches)
  if (scope.touchDispatch.mode === 'select-drag') {
    if (scope.sel) {
      scope.sel.activeHandle = null
    }
    stopEdgeScroll()
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
      Date.now() - scope.tapCandidate.t <= scope.TAP_MAX_MS
    ) {
      notifyTerminalSurfaceTap(scope.tapCandidate.x, scope.tapCandidate.y, true)
    }
    clearLongPress()
    scope.tapCandidate = null
    if (touches.length === 0) {
      scope.touchDispatch.mode = 'idle'
      scope.touchDispatch.touchId = null
    }
  }
}

function onDocumentTouchCancel(e: TouchEvent) {
  if (!touchIsThisDocuments(e)) {
    return
  }
  clearLongPress()
  scope.tapCandidate = null
  stopEdgeScroll()
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
export function startTapDispatch() {
  document.addEventListener('touchstart', onDocumentTouchStart, CAPTURE_ACTIVE)
  document.addEventListener('touchmove', onDocumentTouchMove, CAPTURE_ACTIVE)
  document.addEventListener('touchend', onDocumentTouchEnd, CAPTURE_PASSIVE)
  document.addEventListener('touchcancel', onDocumentTouchCancel, CAPTURE_PASSIVE)
}

export function stopTapDispatch() {
  document.removeEventListener('touchstart', onDocumentTouchStart, CAPTURE_ACTIVE)
  document.removeEventListener('touchmove', onDocumentTouchMove, CAPTURE_ACTIVE)
  document.removeEventListener('touchend', onDocumentTouchEnd, CAPTURE_PASSIVE)
  document.removeEventListener('touchcancel', onDocumentTouchCancel, CAPTURE_PASSIVE)
  clearLongPress()
}
