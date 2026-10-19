import { getCellHeight, getTotalScale } from './cell-metrics'
import type { TerminalDocumentScope } from './document-scope'
import { scheduleDocumentFrame } from './document-frame-registry'
import {
  getMouseTrackingMode,
  isWheelMouseTrackingMode,
  MAX_TUI_SCROLL_REPORTS,
  routeScrollLines,
  shouldRouteScrollToTerminalInput
} from './mouse-input-encoding'
import { mouseReportRowClientY, viewportToMouseReportCell } from './mouse-report-cell'

/**
 * How the program that owns a mouse-tracking screen reads a wheel report. Codex moves one row per
 * report like `one-row`, but only for reports over its history.
 */
export type TuiWheelProfile = 'one-row' | 'claude-code' | 'codex'

/** Rows a Claude Code wheel report moves when it arrives on its own. */
export const CLAUDE_CODE_NOTCH_ROWS = 3
/**
 * Claude Code treats xterm.js (which the desktop answers XTVERSION as) as a high-rate wheel
 * terminal: a report more than 40ms after the previous one is a mouse notch and moves three
 * rows, and reports closer than that move one row each. Reports this close keep the one-row
 * reading after the bridge and the network spread them out; reports sent 30ms apart already
 * arrived as notches some of the time.
 */
export const CLAUDE_CODE_FLOOD_GAP_MS = 22
/** Past this gap a report keeps the notch reading even if the network brings it 12ms closer. */
export const CLAUDE_CODE_NOTCH_GAP_MS = 52

/** The wheel reports to send now and the finger travel, in rows, they will move. */
export type TuiWheelPlan = { reports: number; rows: number }

/**
 * Plans the wheel reports for `pendingRows` of finger travel so the program moves the same
 * number of rows as the finger. A program that moves one row per report gets one report per
 * whole row. Claude Code gets one report per row while reports stay within its flood gap; once
 * they would arrive on their own it gets one three-row notch, sent when the finger is nearer
 * three rows than none, so slow drags and the end of a coast track the finger instead of
 * running three times ahead of it. Between the two gaps either reading is possible, so nothing
 * is sent until the notch reading is certain.
 */
export function planTuiWheelReports(
  profile: TuiWheelProfile,
  pendingRows: number,
  msSinceLastReport: number,
  lastDirection = 0
): TuiWheelPlan {
  if (!Number.isFinite(pendingRows)) {
    return { reports: 0, rows: 0 }
  }
  const direction = Math.sign(pendingRows)
  // A notch can leave Claude Code up to half a notch ahead of the finger; only a finger that
  // has come back past that lead scrolls the other way, so a resting finger never bounces it.
  const lead =
    profile === 'claude-code' && lastDirection !== 0 && direction === -lastDirection
      ? CLAUDE_CODE_NOTCH_ROWS / 2
      : 0
  const travel = Math.abs(pendingRows) - lead
  if (travel <= 0) {
    return { reports: 0, rows: 0 }
  }
  const wholeRows = Math.min(Math.trunc(travel), MAX_TUI_SCROLL_REPORTS)
  if (profile !== 'claude-code' || msSinceLastReport <= CLAUDE_CODE_FLOOD_GAP_MS) {
    return { reports: direction * wholeRows, rows: direction * wholeRows }
  }
  if (msSinceLastReport <= CLAUDE_CODE_NOTCH_GAP_MS || travel < CLAUDE_CODE_NOTCH_ROWS / 2) {
    return { reports: 0, rows: 0 }
  }
  // The first report of the write is the notch; the rest land inside the gap at one row each.
  const extraRows = Math.max(0, wholeRows - CLAUDE_CODE_NOTCH_ROWS)
  return {
    reports: direction * (1 + extraRows),
    rows: direction * (CLAUDE_CODE_NOTCH_ROWS + extraRows)
  }
}

/** The profile that applies now: Claude Code's notch only exists for its own wheel reports. */
export function activeTuiWheelProfile(scope: TerminalDocumentScope): TuiWheelProfile {
  if (scope.tuiWheelProfile !== 'claude-code' || !scope.mouseEncodingKnown) {
    return 'one-row'
  }
  return isWheelMouseTrackingMode(getMouseTrackingMode(scope)) ? 'claude-code' : 'one-row'
}

export function setTuiWheelProfile(scope: TerminalDocumentScope, profile: unknown) {
  scope.tuiWheelProfile = profile === 'claude-code' || profile === 'codex' ? profile : 'one-row'
}

/**
 * Codex drops wheel reports over its composer and footer, the bottom rows a thumb starts or lifts
 * a fling on. Its history fills the top of its screen, so a touch below the middle row reports
 * from the middle row; the rows each report moves stay the same.
 */
function touchWheelReportClientY(scope: TerminalDocumentScope, clientX: number, clientY: number) {
  if (scope.tuiWheelProfile !== 'codex' || !scope.term) {
    return clientY
  }
  const middleRow = Math.floor((scope.term.rows - 1) / 2)
  const cell = viewportToMouseReportCell(scope, clientX, clientY)
  if (!cell || cell.row <= middleRow) {
    return clientY
  }
  return mouseReportRowClientY(scope, middleRow) ?? clientY
}

/** Travel still owes a bounded report, even if a notch needs a wider delivery gap. */
export function hasPendingTouchTravel(scope: TerminalDocumentScope) {
  const cell = getCellHeight(scope) * getTotalScale(scope)
  return (
    cell > 0 &&
    planTuiWheelReports(
      activeTuiWheelProfile(scope),
      scope.touchGesture.accumDelta / cell,
      Number.POSITIVE_INFINITY,
      scope.touchGesture.wheelDirection
    ).reports !== 0
  )
}

/** A new touch or stopped document owns none of the previous gesture's deferred reports. */
export function cancelPendingTouchTravel(scope: TerminalDocumentScope) {
  const id = scope.touchGesture.pendingWheelFrameId
  if (id !== null) {
    cancelAnimationFrame(id)
    // Why: a cancelled frame never runs, so it cannot take its own id off the document's list.
    const at = scope.scheduledFrames.indexOf(id)
    if (at !== -1) {
      scope.scheduledFrames.splice(at, 1)
    }
    scope.touchGesture.pendingWheelFrameId = null
  }
}

function schedulePendingTouchTravel(scope: TerminalDocumentScope) {
  if (
    scope.framesStopped ||
    scope.touchGesture.pendingWheelFrameId !== null ||
    scope.touchGesture.momentumId !== null ||
    !hasPendingTouchTravel(scope)
  ) {
    return
  }
  scope.touchGesture.pendingWheelFrameId = scheduleDocumentFrame(scope, () => {
    scope.touchGesture.pendingWheelFrameId = null
    if (shouldRouteScrollToTerminalInput(scope)) {
      routeTouchTravelToTerminal(scope, scope.touchGesture.lastX, scope.touchGesture.lastY)
    }
  })
}

/** Sends the finger travel held in `accumDelta` to the program; true when reports went out. */
export function routeTouchTravelToTerminal(
  scope: TerminalDocumentScope,
  clientX: number,
  clientY: number
) {
  const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
  if (!(effectiveCellH > 0)) {
    return false
  }
  const plan = planTuiWheelReports(
    activeTuiWheelProfile(scope),
    scope.touchGesture.accumDelta / effectiveCellH,
    performance.now() - scope.lastTuiWheelReportAt,
    scope.touchGesture.wheelDirection
  )
  if (plan.reports === 0) {
    schedulePendingTouchTravel(scope)
    return false
  }
  scope.touchGesture.accumDelta -= plan.rows * effectiveCellH
  scope.touchGesture.wheelDirection = Math.sign(plan.reports)
  routeScrollLines(scope, plan.reports, clientX, touchWheelReportClientY(scope, clientX, clientY))
  schedulePendingTouchTravel(scope)
  return true
}
