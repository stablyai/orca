import type { CrashReportStore } from './crash-report-store'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

export const RENDERER_BOOTSTRAP_RENDERED_BREADCRUMB = 'renderer_bootstrap_rendered'

// Why: field traces show crash -> reload -> React bootstrap under 1.5s; this only
// has to survive a loaded machine, and must expire before an unrelated boot.
const RENDERER_RECOVERY_OUTCOME_WINDOW_MS = 30_000

// Why not the window above: that bounds how long an arm stays valid, this bounds
// how far back the arm may credit crashes — different jobs. The reload is armed
// 250ms after its crash, so only that crash's own kill burst is ever in scope;
// reusing the 30s window dismissed older, unhealed crashes as auto-recovered.
const RENDERER_RECOVERY_CRASH_LOOKBACK_MS = 5_000

let recoveryReloadIssuedAtMs: number | null = null

export function noteRendererRecoveryReloadIssued(nowMs = Date.now()): void {
  recoveryReloadIssuedAtMs = nowMs
}

/**
 * Disarm the outcome check because auto-recovery gave up.
 *
 * Why: the next bootstrap then comes from the user's own retry, and a crash the
 * breaker refused to keep reloading is the one they most need prompted about.
 */
export function clearRendererRecoveryReloadIssued(): void {
  recoveryReloadIssuedAtMs = null
}

function takeRendererRecoveryReloadIssuedAt(nowMs: number): number | null {
  const issuedAtMs = recoveryReloadIssuedAtMs
  recoveryReloadIssuedAtMs = null
  if (issuedAtMs === null || nowMs - issuedAtMs > RENDERER_RECOVERY_OUTCOME_WINDOW_MS) {
    return null
  }
  return issuedAtMs
}

type RecoveredCrashReportStore = Pick<CrashReportStore, 'markRendererCrashesAutoRecovered'>

/**
 * Resolve renderer crash reports that an auto-recovery reload actually healed.
 *
 * Why: this must stay synchronous up to the store call so the write is queued
 * before the recovered renderer's getLatestPending read drains the same chain.
 */
export function resolveRecoveredRendererCrashReports(
  store: RecoveredCrashReportStore,
  nowMs = Date.now()
): void {
  const issuedAtMs = takeRendererRecoveryReloadIssuedAt(nowMs)
  if (issuedAtMs === null) {
    return
  }
  void store
    .markRendererCrashesAutoRecovered(issuedAtMs - RENDERER_RECOVERY_CRASH_LOOKBACK_MS)
    .then((resolved) => {
      if (resolved.length === 0) {
        return
      }
      recordDurableCrashBreadcrumb('renderer_crash_auto_recovered', {
        resolvedReportCount: resolved.length,
        recoveryLatencyMs: nowMs - issuedAtMs
      })
    })
    .catch((error) => {
      console.error('[crash-reporting] Failed to resolve auto-recovered crash reports:', error)
    })
}

export function _resetRendererRecoveryOutcomeForTests(): void {
  clearRendererRecoveryReloadIssued()
}
