import { getCellHeight, getTotalScale } from './cell-metrics'
import type { TerminalDocumentScope } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'
import { shouldRouteScrollToTerminalInput } from './mouse-input-encoding'
import { bounceNormalBufferEnd } from './normal-buffer-overscroll'
import {
  applyNormalBufferScrollDelta,
  resetSmoothScrollOffset
} from './normal-buffer-smooth-scroll'
import {
  cancelPendingTouchTravel,
  hasPendingTouchTravel,
  routeTouchTravelToTerminal
} from './tui-wheel-pacing'

/** UIScrollView's normal deceleration: the share of its speed a coast keeps each millisecond. */
export const MOMENTUM_DECELERATION_PER_MS = 0.998
/** Below this speed, in px/ms, a coast over scrollback has ended. */
export const MOMENTUM_MIN_VELOCITY = 0.012
/**
 * A program scrolls in whole rows, so a coast slower than a row per this many milliseconds is
 * a row ticking past now and then rather than motion; it ends there.
 */
export const PROGRAM_MOMENTUM_MAX_ROW_INTERVAL_MS = 120
/** Touch samples older than this cannot launch or sustain the same flick, in milliseconds. */
export const TOUCH_VELOCITY_MAX_AGE_MS = 100

/** Blends one touchmove's speed into the velocity a release coasts at, in px/ms. */
export function updateTouchVelocity(scope: TerminalDocumentScope, deltaY: number, dt: number) {
  if (dt <= 0) {
    return
  }
  const instantVelocity = deltaY / dt
  if (!Number.isFinite(instantVelocity)) {
    return
  }
  // Why: touchmove cadence is uneven in WebView. Blend recent samples so
  // momentum launch doesn't inherit a one-frame spike or stall. A pause ends
  // that sample history; tiny movement after a rest must not revive the old flick.
  scope.touchGesture.velY =
    scope.touchGesture.velY === 0 || dt > TOUCH_VELOCITY_MAX_AGE_MS
      ? instantVelocity
      : scope.touchGesture.velY * 0.55 + instantVelocity * 0.45
}

function minimumVelocity(scope: TerminalDocumentScope, routed: boolean) {
  if (!routed) {
    return MOMENTUM_MIN_VELOCITY
  }
  const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
  return Math.max(MOMENTUM_MIN_VELOCITY, effectiveCellH / PROGRAM_MOMENTUM_MAX_ROW_INTERVAL_MS)
}

/** Coasts a released fling at `velocity` px/ms, positive toward the newest row. */
export function startTouchMomentum(scope: TerminalDocumentScope, velocity: number) {
  let vel = velocity
  let lastMomentumTime = performance.now()
  const decayRate = Math.log(MOMENTUM_DECELERATION_PER_MS)
  function momentumStep(frameTime: number) {
    const elapsed = Math.max(0, frameTime - lastMomentumTime)
    lastMomentumTime = Math.max(lastMomentumTime, frameTime)
    if (elapsed === 0) {
      scope.touchGesture.momentumId = scheduleDocumentFrame(scope, momentumStep)
      return
    }
    const routed = shouldRouteScrollToTerminalInput(scope)
    const minimum = minimumVelocity(scope, routed)
    if (Math.abs(vel) <= minimum) {
      if (routed) {
        routeTouchTravelToTerminal(scope, scope.touchGesture.lastX, scope.touchGesture.lastY)
      }
      scope.touchGesture.momentumId =
        routed && hasPendingTouchTravel(scope) ? scheduleDocumentFrame(scope, momentumStep) : null
      return
    }
    // Integrate the real interval, including travel before a delayed frame reaches the stop.
    const travelTime = Math.min(elapsed, Math.log(minimum / Math.abs(vel)) / decayRate)
    const delta = (vel * Math.expm1(decayRate * travelTime)) / decayRate
    vel *= Math.exp(decayRate * elapsed)
    if (routed) {
      resetSmoothScrollOffset(scope)
      scope.touchGesture.accumDelta += delta
      routeTouchTravelToTerminal(scope, scope.touchGesture.lastX, scope.touchGesture.lastY)
    } else if (!applyNormalBufferScrollDelta(scope, delta)) {
      scope.touchGesture.momentumId = null
      // A coast that reaches the end of the buffer bounces off it instead of stopping dead.
      bounceNormalBufferEnd(scope, vel)
      return
    }
    if (Math.abs(vel) <= minimum && (!routed || !hasPendingTouchTravel(scope))) {
      scope.touchGesture.momentumId = null
      return
    }
    scope.touchGesture.momentumId = scheduleDocumentFrame(scope, momentumStep)
  }
  if (Math.abs(vel) > MOMENTUM_MIN_VELOCITY) {
    cancelPendingTouchTravel(scope)
    scope.touchGesture.momentumId = scheduleDocumentFrame(scope, momentumStep)
  }
}

/** The finger lifted: the coast takes the last move's speed, which a finger that rested has not. */
export function releaseTouchMomentum(scope: TerminalDocumentScope) {
  const rested = Date.now() - scope.touchGesture.lastTime > TOUCH_VELOCITY_MAX_AGE_MS
  startTouchMomentum(scope, rested ? 0 : scope.touchGesture.velY)
}
