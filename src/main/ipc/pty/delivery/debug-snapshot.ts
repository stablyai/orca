import { getAppEnvironment } from '../../../../shared/app-environment'
import {
  type PtyMainDeliveryDiagnostics,
  type PtyPerPtyDeliveryDiagnostics,
  redactPtyIdForDiagnostics
} from '../../../../shared/pty-delivery-diagnostics'
import {
  getHiddenRendererPtyDeliveryDebug,
  getHiddenRendererPtyIds,
  isHiddenRendererPty
} from '../../pty-hidden-delivery-gate'
import {
  lastPowerResumeAtMs,
  lastPowerSuspendAtMs,
  mainDeliveryBreadcrumbs,
  type PtyRendererDeliveryDebugSnapshot
} from './debug'
import { activeRendererPtys, visibleRendererPtys } from './visibility-state'
import { DELIVERY_DIAGNOSTICS_MAX_PTYS } from './constants'
import type { PtyIpcSession } from '../session'

export function buildMainDeliveryDiagnostics(session: PtyIpcSession): PtyMainDeliveryDiagnostics {
  const now = Date.now()
  // Include hidden/visible/active members even without an accounting entry: a pty gated before its first byte is exactly the wedge case to surface.
  const ids = new Set([
    ...session.rendererDeliveryAccountingByPty.keys(),
    ...session.pendingData.keys(),
    ...getHiddenRendererPtyIds(),
    ...visibleRendererPtys,
    ...activeRendererPtys
  ])
  const perPty: PtyPerPtyDeliveryDiagnostics[] = []
  for (const id of ids) {
    const accounting = session.rendererDeliveryAccountingByPty.get(id)
    perPty.push({
      id: redactPtyIdForDiagnostics(id),
      sentChars: accounting?.sentChars ?? 0,
      ackedChars: accounting?.ackedChars ?? 0,
      inFlightChars: accounting ? accounting.sentChars - accounting.ackedChars : 0,
      pendingChars: session.pendingData.get(id)?.data.length ?? 0,
      hidden: isHiddenRendererPty(id),
      visible: visibleRendererPtys.has(id),
      active: activeRendererPtys.has(id),
      msSinceLastSend: accounting ? now - accounting.lastSendAtMs : null,
      msSinceLastAck: accounting?.lastAckAtMs == null ? null : now - accounting.lastAckAtMs
    })
  }
  perPty.sort((a, b) => b.inFlightChars + b.pendingChars - (a.inFlightChars + a.pendingChars))
  const windowAlive = !session.mainWindow.isDestroyed()
  return {
    appVersion: getAppEnvironment().getVersion(),
    mainUptimeMs: Math.round(process.uptime() * 1000),
    windowFocused: windowAlive ? session.mainWindow.isFocused() : null,
    windowVisible: windowAlive ? session.mainWindow.isVisible() : null,
    windowMinimized: windowAlive ? session.mainWindow.isMinimized() : null,
    msSinceLastPowerSuspend: lastPowerSuspendAtMs === null ? null : now - lastPowerSuspendAtMs,
    msSinceLastPowerResume: lastPowerResumeAtMs === null ? null : now - lastPowerResumeAtMs,
    perPty: perPty.slice(0, DELIVERY_DIAGNOSTICS_MAX_PTYS),
    breadcrumbs: mainDeliveryBreadcrumbs.snapshot()
  }
}

export function readCurrentPtyRendererDeliveryDebugSnapshot(
  session: PtyIpcSession
): PtyRendererDeliveryDebugSnapshot {
  let pendingChars = 0
  let maxPendingCharsByPty = 0
  for (const pending of session.pendingData.values()) {
    const chars = pending.data.length
    pendingChars += chars
    maxPendingCharsByPty = Math.max(maxPendingCharsByPty, chars)
  }
  const hiddenDeliveryDebug = getHiddenRendererPtyDeliveryDebug()
  let rendererInFlightPtyCount = 0
  let maxRendererInFlightCharsByPty = 0
  for (const accounting of session.rendererDeliveryAccountingByPty.values()) {
    const inFlight = accounting.sentChars - accounting.ackedChars
    if (inFlight > 0) {
      rendererInFlightPtyCount++
    }
    maxRendererInFlightCharsByPty = Math.max(maxRendererInFlightCharsByPty, inFlight)
  }
  // Why: a pty both hidden-gated and reported visible means main is starving a visible pane (v1.4.124-rc.2.perf field lead).
  let hiddenDeliveryGatedVisiblePtyCount = 0
  for (const id of visibleRendererPtys) {
    if (isHiddenRendererPty(id)) {
      hiddenDeliveryGatedVisiblePtyCount++
    }
  }
  let hiddenDeliveryGatedActivePtyCount = 0
  for (const id of activeRendererPtys) {
    if (isHiddenRendererPty(id)) {
      hiddenDeliveryGatedActivePtyCount++
    }
  }
  return {
    pendingPtyCount: session.pendingData.size,
    pendingChars,
    maxPendingCharsByPty,
    rendererInFlightPtyCount,
    rendererInFlightChars: session.rendererInFlightTotalChars,
    maxRendererInFlightCharsByPty,
    activeRendererPtyCount: activeRendererPtys.size,
    flushScheduled: session.flushTimer !== null,
    peakPendingChars: session.peakPendingChars,
    peakMaxPendingCharsByPty: session.peakMaxPendingCharsByPty,
    peakRendererInFlightChars: session.peakRendererInFlightChars,
    peakMaxRendererInFlightCharsByPty: session.peakMaxRendererInFlightCharsByPty,
    ackGatedFlushSkipCount: session.ackGatedFlushSkipCount,
    ...hiddenDeliveryDebug,
    hiddenDeliveryGatedVisiblePtyCount,
    hiddenDeliveryGatedActivePtyCount,
    pendingDroppedChars: session.pendingDroppedChars,
    diagnostics: buildMainDeliveryDiagnostics(session),
    rendererLifecycleResetCount: session.rendererLifecycleResetCount,
    lastLifecycleResetClearedChars: session.lastLifecycleResetClearedChars,
    rendererPtyDispatcherReady: session.rendererPtyDispatcherReady,
    rendererDispatcherReadyForcedCount: session.rendererDispatcherReadyForcedCount
  }
}

export function seedPtyRendererDeliveryPeaksFromCurrentState(session: PtyIpcSession): void {
  let pendingChars = 0
  let maxPendingCharsByPty = 0
  for (const pending of session.pendingData.values()) {
    const chars = pending.data.length
    pendingChars += chars
    maxPendingCharsByPty = Math.max(maxPendingCharsByPty, chars)
  }
  session.peakPendingChars = pendingChars
  session.peakMaxPendingCharsByPty = maxPendingCharsByPty
  session.peakRendererInFlightChars = session.rendererInFlightTotalChars
  let maxRendererInFlightCharsByPty = 0
  for (const accounting of session.rendererDeliveryAccountingByPty.values()) {
    maxRendererInFlightCharsByPty = Math.max(
      maxRendererInFlightCharsByPty,
      accounting.sentChars - accounting.ackedChars
    )
  }
  session.peakMaxRendererInFlightCharsByPty = maxRendererInFlightCharsByPty
}

export function warnIfDroppingHiddenBytesForVisiblePty(
  session: PtyIpcSession,
  id: string,
  droppedChars: number
): void {
  if (!visibleRendererPtys.has(id) && !activeRendererPtys.has(id)) {
    return
  }
  // Recorded before the warn rate limit: the ring coalesces repeats, and the contradiction must appear in the freeze report either way.
  mainDeliveryBreadcrumbs.record('hidden-drop-visible', {
    id: redactPtyIdForDiagnostics(id),
    droppedChars
  })
  const now = Date.now()
  if (now - session.lastHiddenDropContradictionWarnAtMs < 60_000) {
    return
  }
  session.lastHiddenDropContradictionWarnAtMs = now
  console.warn('[pty] hidden-delivery gate is dropping bytes for a visible/active pty', {
    id: redactPtyIdForDiagnostics(id),
    droppedChars,
    visible: visibleRendererPtys.has(id),
    active: activeRendererPtys.has(id),
    ...readCurrentPtyRendererDeliveryDebugSnapshot(session)
  })
}
