import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { retryTransientDatabaseStartup } from './database-startup-retry.js'

type CellAdmissionStartupConfig = Pick<RelayConfig, 'role' | 'cells'>
type CellAdmissionStore = Pick<RelayAssignmentStore, 'reconcileCellsAtStartup'>

const STARTUP_RECONCILE_RETRY = {
  attempts: 20,
  windowMs: 45_000,
  // Flat: the contention this waits out is another director's schema lock, which
  // clears on its own schedule rather than easing as the wait grows.
  baseDelayMs: 250,
  maxDelayMs: 250,
  jitterMs: 250
}

export function roleOwnsAssignmentMaintenance(role: RelayConfig['role']): boolean {
  // Cell workers share the database but the director is the sole authority
  // for global expiry, evacuation, and dead-cell maintenance.
  return role !== 'cell'
}

export async function reconcileCellAdmissionAtStartup(
  config: CellAdmissionStartupConfig,
  assignments: CellAdmissionStore
): Promise<void> {
  // Admission is operator/director state. A new worker must not enable itself
  // before its distinct candidate has passed production preflight.
  if (config.role === 'cell') return
  await retryTransientDatabaseStartup(
    async () => await assignments.reconcileCellsAtStartup(config.cells),
    STARTUP_RECONCILE_RETRY,
    {
      onRecovered: ({ attempts }) =>
        console.warn(
          JSON.stringify({ event: 'orca_relay_startup_reconcile_recovered', attempts })
        ),
      onGaveUp: ({ attempts, retryable }) => {
        if (retryable) {
          console.warn(
            JSON.stringify({ event: 'orca_relay_startup_reconcile_exhausted', attempts })
          )
        }
      }
    }
  )
}
