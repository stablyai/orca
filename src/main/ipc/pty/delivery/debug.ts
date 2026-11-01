import { getPtyPower } from '../pty-host-bindings'
import {
  type PtyMainDeliveryDiagnostics,
  EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
  createPtyDeliveryBreadcrumbRing
} from '../../../../shared/pty-delivery-diagnostics'

export type PtyRendererDeliveryDebugSnapshot = {
  pendingPtyCount: number
  pendingChars: number
  maxPendingCharsByPty: number
  rendererInFlightPtyCount: number
  rendererInFlightChars: number
  maxRendererInFlightCharsByPty: number
  activeRendererPtyCount: number
  flushScheduled: boolean
  peakPendingChars: number
  peakMaxPendingCharsByPty: number
  peakRendererInFlightChars: number
  peakMaxRendererInFlightCharsByPty: number
  ackGatedFlushSkipCount: number
  hiddenDeliveryGatedPtyCount: number
  /** Hidden gating contradicting renderer-visible/active state should remain zero. */
  hiddenDeliveryGatedVisiblePtyCount: number
  hiddenDeliveryGatedActivePtyCount: number
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
  pendingDroppedChars: number
  diagnostics: PtyMainDeliveryDiagnostics
  // Cleared debt reveals whether lifecycle reset recovered leaked accounting.
  rendererLifecycleResetCount: number
  lastLifecycleResetClearedChars: number
  // Boot holds precede flush-skip accounting; expose readiness and forced watchdog recovery separately.
  rendererPtyDispatcherReady: boolean
  rendererDispatcherReadyForcedCount: number
}

// Lifecycle-reset and registration code both write delivery breadcrumbs.
export const mainDeliveryBreadcrumbs = createPtyDeliveryBreadcrumbRing()
export let lastPowerSuspendAtMs: number | null = null
export let lastPowerResumeAtMs: number | null = null
let powerSignalBreadcrumbsInstalled = false

// Suspend/resume timestamps correlate freeze reports with display wake.
export function installPowerSignalBreadcrumbs(): void {
  if (powerSignalBreadcrumbsInstalled) {
    return
  }
  powerSignalBreadcrumbsInstalled = true
  const powerMonitor = getPtyPower()
  powerMonitor.on('suspend', () => {
    lastPowerSuspendAtMs = Date.now()
    mainDeliveryBreadcrumbs.record('power-suspend')
  })
  powerMonitor.on('resume', () => {
    lastPowerResumeAtMs = Date.now()
    mainDeliveryBreadcrumbs.record('power-resume')
  })
}

export const EMPTY_PTY_RENDERER_DELIVERY_DEBUG_SNAPSHOT: PtyRendererDeliveryDebugSnapshot = {
  pendingPtyCount: 0,
  pendingChars: 0,
  maxPendingCharsByPty: 0,
  rendererInFlightPtyCount: 0,
  rendererInFlightChars: 0,
  maxRendererInFlightCharsByPty: 0,
  activeRendererPtyCount: 0,
  flushScheduled: false,
  peakPendingChars: 0,
  peakMaxPendingCharsByPty: 0,
  peakRendererInFlightChars: 0,
  peakMaxRendererInFlightCharsByPty: 0,
  ackGatedFlushSkipCount: 0,
  hiddenDeliveryGatedPtyCount: 0,
  hiddenDeliveryGatedVisiblePtyCount: 0,
  hiddenDeliveryGatedActivePtyCount: 0,
  deliveryInterestPtyCount: 0,
  hiddenDeliveryDroppedChars: 0,
  hiddenDeliveryDroppedChunks: 0,
  pendingDroppedChars: 0,
  diagnostics: EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
  rendererLifecycleResetCount: 0,
  lastLifecycleResetClearedChars: 0,
  rendererPtyDispatcherReady: false,
  rendererDispatcherReadyForcedCount: 0
}

// Use null-initialized wrapper bridges: Rolldown can fold exported no-op functions and discard later replacements (STA-5661).
let readPtyRendererDeliveryDebugSnapshotImpl: (() => PtyRendererDeliveryDebugSnapshot) | null = null
let resetPtyRendererDeliveryDebugSnapshotImpl: (() => void) | null = null
// Module-scope lifecycle reset must reach registration-owned delivery accounting.
let resetRendererDeliveryAccountingForLifecycleResetImpl: (() => void) | null = null
// Re-registration must cancel the outgoing closure's readiness watchdog.
let clearRendererDispatcherReadyWatchdogImpl: (() => void) | null = null

export function readPtyRendererDeliveryDebugSnapshot(): PtyRendererDeliveryDebugSnapshot {
  return (
    readPtyRendererDeliveryDebugSnapshotImpl?.() ?? {
      ...EMPTY_PTY_RENDERER_DELIVERY_DEBUG_SNAPSHOT
    }
  )
}

export function resetPtyRendererDeliveryDebugSnapshot(): void {
  resetPtyRendererDeliveryDebugSnapshotImpl?.()
}

export function resetRendererDeliveryAccountingForLifecycleReset(): void {
  resetRendererDeliveryAccountingForLifecycleResetImpl?.()
}

export function clearRendererDispatcherReadyWatchdog(): void {
  clearRendererDispatcherReadyWatchdogImpl?.()
}

export function setReadPtyRendererDeliveryDebugSnapshot(
  fn: () => PtyRendererDeliveryDebugSnapshot
): void {
  readPtyRendererDeliveryDebugSnapshotImpl = fn
}

export function setResetPtyRendererDeliveryDebugSnapshot(fn: () => void): void {
  resetPtyRendererDeliveryDebugSnapshotImpl = fn
}

export function setResetRendererDeliveryAccountingForLifecycleReset(fn: () => void): void {
  resetRendererDeliveryAccountingForLifecycleResetImpl = fn
}

export function setClearRendererDispatcherReadyWatchdog(fn: () => void): void {
  clearRendererDispatcherReadyWatchdogImpl = fn
}

export function getPtyRendererDeliveryDebugSnapshot(): PtyRendererDeliveryDebugSnapshot {
  return readPtyRendererDeliveryDebugSnapshot()
}

export function resetPtyRendererDeliveryDebug(): void {
  resetPtyRendererDeliveryDebugSnapshot()
}
