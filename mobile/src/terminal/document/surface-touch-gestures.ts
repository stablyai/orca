import { getTotalScale } from './cell-metrics'
import type { TerminalDocumentScope } from './document-scope'
import { touchesInRoot } from './document-host-seams'
import { clampPan } from './fit-scale'
import { notify } from './host-notify'
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

/** A surface that has already been wired, so a re-mount does not stack handlers. */
type TerminalGestureSurface = HTMLElement & { __orcaSurfaceHandlersAttached?: boolean }

/** The travel before a pixel-scrolled drag moves the text, in pixels. */
const PIXEL_SCROLL_DRAG_SLOP = 8

/** The live touch gesture: the last point, the velocity, and the pinch it may be in. */
export type TerminalTouchState = {
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

/** The pinch's anchor, in the grid's frame: the point between the two fingers. */
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
  // Why: init() swaps in a new hidden surface to avoid flicker; each
  // replacement needs gesture handlers or tab-switch replays stop scrolling.
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
      if (dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (scope.touchGesture.momentumId) {
        cancelAnimationFrame(scope.touchGesture.momentumId)
        scope.touchGesture.momentumId = null
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
        scope.touchGesture.isPinching = true
        resetSmoothScrollOffset(scope)
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
    },
    { capture: true, passive: true }
  )

  targetSurface.addEventListener(
    'touchmove',
    function (e) {
      if (dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (!scope.term) {
        return
      }
      e.preventDefault()
      e.stopPropagation()

      const touches = touchesInRoot(scope.root, e.touches)
      if (touches.length === 2) {
        scope.touchGesture.isPinching = true
        const dist = getDistance(touches[0], touches[1])
        const mid = pinchMidpoint(scope, touches[0], touches[1])

        const ratio = dist / scope.touchGesture.pinchDist
        // Why: userScale is a CSS multiplier on the current font size; bound it so
        // the resulting apparent size (currentTextScale × userScale) stays within
        // the preset range, since release snaps to one of those presets.
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

        // Why: pan horizontally only when content overflows the viewport (larger
        // than fit) — same check clampPan() uses. Vertical always drives buffer
        // scroll so scrollback stays reachable at any text size; calling the
        // never-defined contentWiderThanViewport() here threw and killed all
        // single-finger scrolling, scrollback included.
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
      if (dispatcherShouldBlockSurface(scope)) {
        return
      }
      if (!scope.term) {
        return
      }

      const touches = touchesInRoot(scope.root, e.touches)
      if (scope.touchGesture.isPinching && touches.length < 2) {
        scope.touchGesture.isPinching = false
        // Why: a finished pinch snaps to the nearest preset and becomes the new
        // font size (reflowing the grid), so pinch-to-zoom IS the in-terminal way
        // to set the text size. The CSS pinch zoom (userScale) is reset; the real
        // size change reflows columns and RN persists + resizes the PTY to match.
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
}

export function startSurfaceTouchGestures(scope: TerminalDocumentScope) {
  attachSurfaceEventHandlers(scope, scope.surface!)
}

/**
 * Ruling 21: the momentum loop, the paced wheel travel and the rubber band's spring, each of which
 * would keep moving the terminal that replaced it.
 */
export function stopSurfaceTouchGestures(scope: TerminalDocumentScope) {
  if (scope.touchGesture.momentumId !== null) {
    cancelAnimationFrame(scope.touchGesture.momentumId)
    scope.touchGesture.momentumId = null
  }
  cancelPendingTouchTravel(scope)
  settleNormalBufferOverscroll(scope)
}
