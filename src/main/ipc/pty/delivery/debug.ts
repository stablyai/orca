import { getPtyPower } from '../../pty-host-bindings'
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
  /** Hidden-gated ptys the renderer ALSO reports visible/active — a contradiction that should be zero (v1.4.124-rc.2.perf field lead). */
  hiddenDeliveryGatedVisiblePtyCount: number
  hiddenDeliveryGatedActivePtyCount: number
  deliveryInterestPtyCount: number
  hiddenDeliveryDroppedChars: number
  hiddenDeliveryDroppedChunks: number
  pendingDroppedChars: number
  /** One-paste freeze diagnostics: per-pty delivery table + event history. */
  diagnostics: PtyMainDeliveryDiagnostics
  // Why: a nonzero lastLifecycleResetClearedChars is the exact signature of the leaked-accounting freeze this reset fixes.
  rendererLifecycleResetCount: number
  lastLifecycleResetClearedChars: number
  // Why: the boot-window hold early-returns before ackGatedFlushSkipCount++, so these expose an otherwise-invisible held gate; forcedCount > 0 flags a watchdog self-heal.
  rendererPtyDispatcherReady: boolean
  rendererDispatcherReadyForcedCount: number
}

// Why module scope: breadcrumb writers live both inside registerPtyHandlers and outside it (renderer lifecycle resets).
export const mainDeliveryBreadcrumbs = createPtyDeliveryBreadcrumbRing()
export let lastPowerSuspendAtMs: number | null = null
export let lastPowerResumeAtMs: number | null = null
let powerSignalBreadcrumbsInstalled = false

// Why: both field freeze variants correlate with display sleep; suspend/resume timestamps let breadcrumbs line up against the wake.
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

export let readPtyRendererDeliveryDebugSnapshot = (): PtyRendererDeliveryDebugSnapshot => ({
  ...EMPTY_PTY_RENDERER_DELIVERY_DEBUG_SNAPSHOT
})
export let resetPtyRendererDeliveryDebugSnapshot = (): void => {}
// Bridged into the registerPtyHandlers closure so the module-scope lifecycle-reset handler can zero closure-owned delivery accounting on renderer reload/crash.
export let resetRendererDeliveryAccountingForLifecycleReset = (): void => {}
// Bridged so a re-registration can cancel the prior closure's dispatcher-ready watchdog before wiring its own.
export let clearRendererDispatcherReadyWatchdog = (): void => {}

export function setReadPtyRendererDeliveryDebugSnapshot(
  fn: () => PtyRendererDeliveryDebugSnapshot
): void {
  readPtyRendererDeliveryDebugSnapshot = fn
}

export function setResetPtyRendererDeliveryDebugSnapshot(fn: () => void): void {
  resetPtyRendererDeliveryDebugSnapshot = fn
}

export function setResetRendererDeliveryAccountingForLifecycleReset(fn: () => void): void {
  resetRendererDeliveryAccountingForLifecycleReset = fn
}

export function setClearRendererDispatcherReadyWatchdog(fn: () => void): void {
  clearRendererDispatcherReadyWatchdog = fn
}

export function getPtyRendererDeliveryDebugSnapshot(): PtyRendererDeliveryDebugSnapshot {
  return readPtyRendererDeliveryDebugSnapshot()
}

export function resetPtyRendererDeliveryDebug(): void {
  resetPtyRendererDeliveryDebugSnapshot()
}
