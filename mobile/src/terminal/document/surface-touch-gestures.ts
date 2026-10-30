import { getTotalScale } from './cell-metrics'
import type { TerminalDocumentScope } from './document-scope'
import { cancelDocumentFrame } from './document-frame-registry'
import { touchesInRoot } from './document-host-seams'
import { clampPan } from './fit-scale'
import { notify } from './host-notify'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { attachSurfaceMouseClickDragHandler } from './mouse-click-drag'
import { shouldRouteScrollToTerminalInput } from './mouse-input-encoding'
import {
  catchNormalBufferOverscroll,
  easeNormalBufferOverscroll,
  isNormalBufferOverscrolled,
  releaseNormalBufferOverscroll,
  settleNormalBufferOverscroll,
  stretchNormalBufferOverscroll
} from './normal-buffer-overscroll'
import {
  cancelPendingNormalScroll,
  enqueueNormalBufferScrollDelta,
  resetSmoothScrollOffset
} from './normal-buffer-smooth-scroll'
import { clearLongPress, dispatcherShouldBlockSurface } from './tap-dispatch'
import {
  applyTextScale,
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  snapToTextScalePreset
} from './text-scaling'
import { releaseTouchMomentum, updateTouchVelocity } from './touch-momentum'
import { cancelPendingTouchTravel, routeTouchTravelToTerminal } from './tui-wheel-pacing'
import { updateTransform } from './viewport-transform'
import { viewportPoint } from './viewport-cell'
import { attachSurfaceWheelHandler } from './wheel-scroll'

type TerminalGestureSurface = HTMLElement & { __orcaSurfaceHandlersAttached?: boolean }

/** The travel before a pixel-scrolled drag moves the text, in pixels. */
const PIXEL_SCROLL_DRAG_SLOP = 8

export type TerminalTouchState = {
  active: boolean
  lastX: number
  lastY: number
  lastTime: number
  velY: number
  accumDelta: number
  /** The direction of the last wheel report this gesture sent a program, 0 before any. */
  wheelDirection: number
  momentumId: number | null
  /** `tui-wheel-pacing`: the frame that delivers travel a paced program is still owed. */
  pendingWheelFrameId: number | null
  isPinching: boolean
  scrollDragActive: boolean
  pinchDist: number
  pinchScale: number
  pinchSurfX: number
  pinchSurfY: number
}

export function getDistance(a: Touch, b: Touch) {
  const dx = a.clientX - b.clientX,
    dy = a.clientY - b.clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function pinchMidpoint(scope: TerminalDocumentScope, a: Touch, b: Touch) {
  return viewportPoint(scope, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
}

export function attachSurfaceEventHandlers(
  scope: TerminalDocumentScope,
  targetSurface: TerminalGestureSurface
) {
  if (!targetSurface || targetSurface.__orcaSurfaceHandlersAttached) {
    return
  }
  targetSurface.__orcaSurfaceHandlersAttached = true
  // Each hidden replay replacement needs handlers; wiring only the first surface breaks scrolling after tab switches.
  targetSurface.addEventListener(
    'mousedown',
    function (e) {
      e.preventDefault()
      e.stopPropagation()
    },
    true
  )
  targetSurface.addEventListener(
    'click',
    function (e) {
      e.preventDefault()
      e.stopPropagation()
    },
    true
  )

  attachSurfaceWheelHandler(scope, targetSurface)
  attachSurfaceMouseClickDragHandler(scope, targetSurface)

  targetSurface.addEventListener(
    'touchstart',
    function (e) {
      if (targetSurface !== scope.surface || dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (scope.touchGesture.momentumId) {
        cancelDocumentFrame(scope, scope.touchGesture.momentumId)
        scope.touchGesture.momentumId = null
        // A touch that stopped momentum must not also fire a tap.
        scope.tapCandidate = null
      }
      // Why: a new touch holds the text where it is drawn, so travel the last one queued is dropped.
      cancelPendingNormalScroll(scope)
      cancelPendingTouchTravel(scope)
      // Why: a touch catches a bounce mid-flight, as UIScrollView does, and carries on from there.
      if (catchNormalBufferOverscroll(scope)) {
        scope.tapCandidate = null
      }
      if (scope.term) {
        scope.pixelScrollActive =
          scope.term.setViewportPixelOffset?.(scope.smoothScrollOffsetY / getTotalScale(scope)) ===
          true
      }
      scope.touchGesture.scrollDragActive = false
      const touches = touchesInRoot(scope.root, e.touches)
      if (touches.length === 2) {
        stopSurfaceTouchGestures(scope)
        resetSmoothScrollOffset(scope)
        scope.touchGesture.isPinching = true
        settleNormalBufferOverscroll(scope)
        scope.touchGesture.pinchDist = getDistance(touches[0], touches[1])
        scope.touchGesture.pinchScale = scope.userScale
        const mid = pinchMidpoint(scope, touches[0], touches[1])
        const total = getTotalScale(scope)
        scope.touchGesture.pinchSurfX = (mid.x - scope.panX) / total
        scope.touchGesture.pinchSurfY = (mid.y - scope.panY) / total
      } else if (touches.length === 1) {
        scope.touchGesture.isPinching = false
        scope.touchGesture.lastX = touches[0].clientX
        scope.touchGesture.lastY = touches[0].clientY
        scope.touchGesture.lastTime = Date.now()
        scope.touchGesture.velY = 0
        scope.touchGesture.accumDelta = 0
        scope.touchGesture.wheelDirection = 0
      }
      scope.touchGesture.active = touches.length > 0
    },
    { capture: true, passive: true }
  )

  targetSurface.addEventListener(
    'touchmove',
    function (e) {
      if (
        targetSurface !== scope.surface ||
        scope.touchDispatch.mode === 'select-drag' ||
        !scope.term
      ) {
        return
      }
      // Claim inactive and interrupted moves too, or xterm's own touch scroller moves the buffer.
      e.preventDefault()
      e.stopPropagation()
      if (!scope.interactionActive || !scope.touchGesture.active) {
        return
      }

      const touches = touchesInRoot(scope.root, e.touches)
      if (touches.length === 2) {
        scope.touchGesture.isPinching = true
        const dist = getDistance(touches[0], touches[1])
        const mid = pinchMidpoint(scope, touches[0], touches[1])

        const ratio = dist / scope.touchGesture.pinchDist
        // Clamp apparent text size to presets while userScale adds transient CSS pinch zoom.
        const loScale = MIN_TEXT_SCALE / scope.currentTextScale
        const hiScale = MAX_TEXT_SCALE / scope.currentTextScale
        scope.userScale = Math.max(
          loScale,
          Math.min(hiScale, scope.touchGesture.pinchScale * ratio)
        )
        const total = getTotalScale(scope)
        scope.panX = mid.x - scope.touchGesture.pinchSurfX * total
        scope.panY = mid.y - scope.touchGesture.pinchSurfY * total
        clampPan(scope)
        updateTransform(scope)
      } else if (touches.length === 1 && !scope.touchGesture.isPinching) {
        const x = touches[0].clientX,
          y = touches[0].clientY
        const now = Date.now(),
          dt = now - scope.touchGesture.lastTime

        // Pan horizontally only on overflow; vertical gestures always drive buffer scroll to keep scrollback reachable.
        if (
          scope.term.element &&
          scope.term.element.scrollWidth * getTotalScale(scope) > scope.viewportRect().width + 1
        ) {
          scope.panX += x - scope.touchGesture.lastX
          clampPan(scope)
          updateTransform(scope)
        }

        // Why: pixel scrolling shows every pixel of travel, so a resting finger's jitter would
        // shake the text; the drag moves it only once the finger has clearly left its start.
        if (
          scope.pixelScrollActive &&
          !shouldRouteScrollToTerminalInput(scope) &&
          !scope.touchGesture.scrollDragActive
        ) {
          if (Math.abs(scope.touchGesture.lastY - y) <= PIXEL_SCROLL_DRAG_SLOP) {
            scope.touchGesture.lastX = x
            return
          }
          scope.touchGesture.scrollDragActive = true
          // Why: scrolling owns this touch before the queued paint; it cannot also select or tap.
          clearLongPress(scope)
          scope.tapCandidate = null
        }
        const deltaY = scope.touchGesture.lastY - y
        scope.touchGesture.lastTime = now
        if (shouldRouteScrollToTerminalInput(scope)) {
          updateTouchVelocity(scope, deltaY, dt)
          resetSmoothScrollOffset(scope)
          settleNormalBufferOverscroll(scope)
          scope.touchGesture.accumDelta += deltaY
          routeTouchTravelToTerminal(scope, x, y)
        } else {
          const rest = easeNormalBufferOverscroll(scope, deltaY)
          if (rest !== 0 && enqueueNormalBufferScrollDelta(scope, rest)) {
            updateTouchVelocity(scope, deltaY, dt)
          } else {
            if (rest !== 0) {
              // Why: the buffer is at its end, so the content follows the finger on a rubber band.
              stretchNormalBufferOverscroll(scope, rest)
            }
            scope.touchGesture.velY = 0
          }
        }
        scope.touchGesture.lastX = x
        scope.touchGesture.lastY = y
      }
    },
    { capture: true, passive: false }
  )

  targetSurface.addEventListener(
    'touchend',
    function (e) {
      if (targetSurface !== scope.surface || dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (!scope.term || !scope.touchGesture.active) {
        return
      }

      const touches = touchesInRoot(scope.root, e.touches)
      if (scope.touchGesture.isPinching && touches.length < 2) {
        scope.touchGesture.isPinching = false
        // Commit pinch to a real font preset, reset transient zoom, and let native resize the PTY to the reflowed grid.
        const target = snapToTextScalePreset(scope.currentTextScale * scope.userScale)
        const changed = target !== scope.currentTextScale
        scope.userScale = 1
        scope.panX = 0
        scope.panY = 0
        applyTextScale(scope, target)
        updateTransform(scope)
        notify(scope, { type: 'font-scale-changed', fontScale: target })
        if (changed) {
          notify(scope, { type: 'haptic', kind: 'selection' })
        }
        if (touches.length === 1) {
          scope.touchGesture.lastX = touches[0].clientX
          scope.touchGesture.lastY = touches[0].clientY
          scope.touchGesture.lastTime = Date.now()
          scope.touchGesture.velY = 0
          scope.touchGesture.accumDelta = 0
        }
        return
      }

      if (touches.length === 0) {
        scope.touchGesture.active = false
        if (isNormalBufferOverscrolled(scope)) {
          // Why: a pull past an end springs back; it never launches a coast.
          releaseNormalBufferOverscroll(scope)
          return
        }
        releaseTouchMomentum(scope)
      }
    },
    { capture: true, passive: true }
  )

  targetSurface.addEventListener(
    'touchcancel',
    function () {
      if (targetSurface !== scope.surface) {
        return
      }
      stopSurfaceTouchGestures(scope)
      resetSmoothScrollOffset(scope)
    },
    { capture: true, passive: true }
  )
}

export function startSurfaceTouchGestures(scope: TerminalDocumentScope) {
  attachSurfaceEventHandlers(scope, scope.surface!)
}

/**
 * Ruling 21: the momentum loop, the paced wheel travel and the rubber band's spring, each of which
 * would keep moving the terminal that replaced it.
 */
export function stopSurfaceTouchGestures(scope: TerminalDocumentScope) {
  const interruptedPinch = scope.touchGesture.isPinching
  scope.touchGesture.active = false
  if (scope.touchGesture.momentumId !== null) {
    cancelDocumentFrame(scope, scope.touchGesture.momentumId)
    scope.touchGesture.momentumId = null
  }
  cancelPendingTouchTravel(scope)
  settleNormalBufferOverscroll(scope)
  scope.touchGesture.velY = 0
  scope.touchGesture.accumDelta = 0
  scope.touchGesture.isPinching = false
  if (interruptedPinch) {
    scope.userScale = 1
    scope.panX = 0
    scope.panY = 0
    if (scope.surface) {
      updateTransform(scope)
    }
    emitKeyboardAvoidanceMetrics(scope)
  }
}
