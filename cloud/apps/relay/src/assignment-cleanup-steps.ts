import { runRelayBackgroundOperation } from './relay-background-operation.js'

// The ten periodic assignment sweeps the director runs every 30s. Each step
// re-derives its state from the database and is idempotent, so they carry no
// intra-tick ordering dependency — which is what makes per-step isolation
// sound: one failing sweep costs one tick of itself, never the other nine.
// (A single poisoned rehome row once silenced the whole chained form
// fleet-wide.) Sweep failures are logged, never fed into the rehome worker's
// dispatch-failure budget: a sweep exception is not a dispatch failure and
// must not durably disable regional rehoming.
export type AssignmentCleanupStore = {
  refreshRegionalRehomeLeases(): Promise<unknown>
  completeReadyEvacuations(): Promise<unknown>
  completeReadyRegionalRehomes(): Promise<unknown>
  abortExpiredEvacuations(): Promise<unknown>
  abortExpiredRegionalRehomes(): Promise<unknown>
  reapRegionalRehomeAttempts(): Promise<unknown>
  releaseExpiredActivityLeases(): Promise<unknown>
  releaseExpiredActivity(): Promise<unknown>
  releaseExpiredRegionPreferences(): Promise<unknown>
  evacuateDeadCells(): Promise<unknown>
}

export function assignmentCleanupSteps(
  assignments: AssignmentCleanupStore
): ReadonlyArray<readonly [string, () => Promise<unknown>]> {
  return [
    ['refresh-regional-rehome-leases', () => assignments.refreshRegionalRehomeLeases()],
    ['complete-ready-evacuations', () => assignments.completeReadyEvacuations()],
    ['complete-ready-regional-rehomes', () => assignments.completeReadyRegionalRehomes()],
    ['abort-expired-evacuations', () => assignments.abortExpiredEvacuations()],
    ['abort-expired-regional-rehomes', () => assignments.abortExpiredRegionalRehomes()],
    ['reap-regional-rehome-attempts', () => assignments.reapRegionalRehomeAttempts()],
    ['release-expired-activity-leases', () => assignments.releaseExpiredActivityLeases()],
    ['release-expired-activity', () => assignments.releaseExpiredActivity()],
    ['release-expired-region-preferences', () => assignments.releaseExpiredRegionPreferences()],
    ['evacuate-dead-cells', () => assignments.evacuateDeadCells()]
  ]
}

export async function runAssignmentCleanup(
  assignments: AssignmentCleanupStore,
  warn?: (message: string) => void
): Promise<void> {
  for (const [step, operation] of assignmentCleanupSteps(assignments)) {
    await runRelayBackgroundOperation(
      operation,
      `[orca-relay] assignment cleanup failed: ${step}`,
      warn
    )
  }
}
