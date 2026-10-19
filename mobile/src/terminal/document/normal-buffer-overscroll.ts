import type { TerminalDocumentScope } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'
import { updateTransform } from './viewport-transform'

/** UIScrollView's rubber-band constant: how stiffly content resists a pull past its end. */
const RUBBER_BAND_COEFFICIENT = 0.55
/** The return spring's rate per millisecond; critically damped, it settles in about 0.45s as UIKit's does. */
const SPRING_RATE_PER_MS = 0.012
/** The fastest coast an end turns into a bounce, so a hard flick cannot throw the grid off screen. */
const MAX_BOUNCE_VELOCITY = 4
const SETTLED_OFFSET_PX = 0.5
const SETTLED_VELOCITY = 0.02

/** How far content pulled `travel` past an end shows, in a viewport `dimension` tall. */
export function rubberBandOffset(travel: number, dimension: number) {
  if (!(dimension > 0) || travel === 0) {
    return 0
  }
  const magnitude =
    (1 - 1 / ((Math.abs(travel) * RUBBER_BAND_COEFFICIENT) / dimension + 1)) * dimension
  return Math.sign(travel) * magnitude
}

/** The pull that shows `offset`, so a touch that catches a bounce carries on from where it is. */
export function rubberBandTravel(offset: number, dimension: number) {
  if (!(dimension > 0) || offset === 0) {
    return 0
  }
  const shown = Math.min(Math.abs(offset) / dimension, 0.99)
  return Math.sign(offset) * ((dimension * (1 / (1 - shown) - 1)) / RUBBER_BAND_COEFFICIENT)
}

function showOverscroll(scope: TerminalDocumentScope, offset: number) {
  scope.overscrollY = offset
  if (scope.surface) {
    updateTransform(scope)
  }
}

function stopOverscrollSpring(scope: TerminalDocumentScope) {
  if (scope.overscrollFrameId !== null) {
    cancelAnimationFrame(scope.overscrollFrameId)
    // Why: a cancelled frame never runs, so it cannot take its own id off the document's list.
    const at = scope.scheduledFrames.indexOf(scope.overscrollFrameId)
    if (at !== -1) {
      scope.scheduledFrames.splice(at, 1)
    }
    scope.overscrollFrameId = null
  }
}

/** Holds a returning bounce where it is; the touch that caught it now owns the pull. */
export function catchNormalBufferOverscroll(scope: TerminalDocumentScope) {
  const bouncing = scope.overscrollFrameId !== null
  stopOverscrollSpring(scope)
  scope.overscrollTravelY = rubberBandTravel(scope.overscrollY, scope.viewportRect().height)
  return bouncing
}

/** Puts the content back at its end at once, for pinches, buffer swaps and teardown. */
export function settleNormalBufferOverscroll(scope: TerminalDocumentScope) {
  stopOverscrollSpring(scope)
  scope.overscrollTravelY = 0
  if (scope.overscrollY !== 0) {
    showOverscroll(scope, 0)
  }
}

export function isNormalBufferOverscrolled(scope: TerminalDocumentScope) {
  return scope.overscrollTravelY !== 0 || scope.overscrollY !== 0
}

function setOverscrollTravel(scope: TerminalDocumentScope, travel: number) {
  scope.overscrollTravelY = travel
  showOverscroll(scope, rubberBandOffset(travel, scope.viewportRect().height))
}

/**
 * Spends finger travel `deltaY` (positive scrolls toward the newest row) on a pull that is
 * already showing and returns what is left for the buffer. Moving further past the end
 * stretches the pull; moving back eases it, and only travel beyond its release scrolls rows.
 */
export function easeNormalBufferOverscroll(scope: TerminalDocumentScope, deltaY: number) {
  const travel = scope.overscrollTravelY
  if (travel === 0 || deltaY === 0) {
    return deltaY
  }
  const next = travel - deltaY
  if (next !== 0 && Math.sign(next) === Math.sign(travel)) {
    setOverscrollTravel(scope, next)
    return 0
  }
  setOverscrollTravel(scope, 0)
  return -next
}

/** Starts a pull with travel the buffer could not take because it is at its end. */
export function stretchNormalBufferOverscroll(scope: TerminalDocumentScope, deltaY: number) {
  stopOverscrollSpring(scope)
  setOverscrollTravel(scope, scope.overscrollTravelY - deltaY)
}

// Critically damped: x(t) = (x0 + (v0 + w x0) t) e^(-w t), the spring UIKit's bounce follows.
function runOverscrollSpring(scope: TerminalDocumentScope, offset: number, velocity: number) {
  stopOverscrollSpring(scope)
  scope.overscrollTravelY = 0
  const rate = SPRING_RATE_PER_MS
  const lead = velocity + rate * offset
  let start: number | null = null
  function step(frameTime: number) {
    start ??= frameTime
    const t = frameTime - start
    const decay = Math.exp(-rate * t)
    const shown = (offset + lead * t) * decay
    const speed = (velocity - rate * lead * t) * decay
    if (t > 0 && Math.abs(shown) < SETTLED_OFFSET_PX && Math.abs(speed) < SETTLED_VELOCITY) {
      scope.overscrollFrameId = null
      showOverscroll(scope, 0)
      return
    }
    scope.overscrollFrameId = scheduleDocumentFrame(scope, step)
    showOverscroll(scope, shown)
  }
  scope.overscrollFrameId = scheduleDocumentFrame(scope, step)
}

/** The finger lifted while pulling: the content springs back to its end. */
export function releaseNormalBufferOverscroll(scope: TerminalDocumentScope) {
  if (scope.overscrollY === 0) {
    scope.overscrollTravelY = 0
    return
  }
  runOverscrollSpring(scope, scope.overscrollY, 0)
}

/**
 * A coast reached an end: its speed carries the content past the end and the spring brings it
 * back. `velocity` is in buffer travel per millisecond, positive toward the newest row.
 */
export function bounceNormalBufferEnd(scope: TerminalDocumentScope, velocity: number) {
  if (!Number.isFinite(velocity) || velocity === 0) {
    return
  }
  const capped = Math.max(-MAX_BOUNCE_VELOCITY, Math.min(MAX_BOUNCE_VELOCITY, velocity))
  runOverscrollSpring(scope, scope.overscrollY, -capped)
}
