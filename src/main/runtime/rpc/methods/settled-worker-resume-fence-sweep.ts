import type { OrcaRuntimeService } from '../../orca-runtime'
import type { LifecycleReconciliationResult } from '../../orchestration/lifecycle-reconciliation'

/**
 * Why: one pass both stamps the resume fence on every settled worker pane and lifts it from every
 * pane the recovery plan no longer claims. `startFreshSpawn` refuses a fenced pane, so any path
 * that drops a worker's row from that plan — release, user retain, user takeover — has to run the
 * sweep, or the fence outlives its dispatch and the pane cannot spawn until the next app start.
 * Failures are swallowed: a fence sweep must never fail the RPC that triggered it.
 */
export function sweepSettledWorkerResumeFences(runtime: OrcaRuntimeService): void {
  try {
    runtime.prepareLegacyWorkerTerminalRecovery()
  } catch (error) {
    console.warn('[orchestration] settled worker resume fence sweep failed', error)
  }
}

/**
 * Why: settlement is the moment a worker's pane stops being resumable work. Stamping the fence
 * here — not at release — is what lets it win the race with a workspace return. One sweep covers
 * every settled pane, so a batch of reconciled messages needs at most one.
 */
export function sweepSettledWorkerResumeFencesForLifecycle(
  runtime: OrcaRuntimeService,
  reconciled: readonly LifecycleReconciliationResult[]
): void {
  if (reconciled.some((result) => result.action === 'completed' || result.action === 'failed')) {
    sweepSettledWorkerResumeFences(runtime)
  }
}
