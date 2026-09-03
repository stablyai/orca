import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import { isRelayDatabaseTransientError } from './database.js'

type CellAdmissionStartupConfig = Pick<RelayConfig, 'role' | 'cells'>
type CellAdmissionStore = Pick<RelayAssignmentStore, 'reconcileCellsAtStartup'>

const STARTUP_RECONCILE_ATTEMPTS = 20
const STARTUP_RECONCILE_RETRY_WINDOW_MS = 45_000
const STARTUP_RECONCILE_RETRY_BASE_MS = 250
const STARTUP_RECONCILE_RETRY_JITTER_MS = 250

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
  const retryDeadline = Date.now() + STARTUP_RECONCILE_RETRY_WINDOW_MS
  for (let attempt = 1; attempt <= STARTUP_RECONCILE_ATTEMPTS; attempt += 1) {
    try {
      await assignments.reconcileCellsAtStartup(config.cells)
      if (attempt > 1) {
        console.warn(
          JSON.stringify({ event: 'orca_relay_startup_reconcile_recovered', attempts: attempt })
        )
      }
      return
    } catch (error) {
      const remainingMs = retryDeadline - Date.now()
      if (
        attempt === STARTUP_RECONCILE_ATTEMPTS ||
        remainingMs <= 0 ||
        !isRelayDatabaseTransientError(error)
      ) {
        if (isRelayDatabaseTransientError(error)) {
          console.warn(
            JSON.stringify({ event: 'orca_relay_startup_reconcile_exhausted', attempts: attempt })
          )
        }
        throw error
      }
      const delayMs =
        STARTUP_RECONCILE_RETRY_BASE_MS +
        Math.floor(Math.random() * (STARTUP_RECONCILE_RETRY_JITTER_MS + 1))
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)))
    }
  }
}
