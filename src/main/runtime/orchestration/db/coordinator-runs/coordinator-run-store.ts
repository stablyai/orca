import type { CoordinatorStatus, CoordinatorRun } from '../../types'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// ── Coordinator Runs ──

export function createCoordinatorRun(
  this: OrchestrationDb,
  run: {
    spec: string
    coordinatorHandle: string
    pollIntervalMs?: number
  }
): CoordinatorRun {
  const id = generateId('run')
  this.db
    .prepare(
      "INSERT INTO coordinator_runs (id, spec, status, coordinator_handle, poll_interval_ms) VALUES (?, ?, 'running', ?, ?)"
    )
    .run(id, run.spec, run.coordinatorHandle, run.pollIntervalMs ?? 2000)
  return this.db.prepare('SELECT * FROM coordinator_runs WHERE id = ?').get(id) as CoordinatorRun
}

export function getCoordinatorRun(this: OrchestrationDb, id: string): CoordinatorRun | undefined {
  return this.db.prepare('SELECT * FROM coordinator_runs WHERE id = ?').get(id) as
    | CoordinatorRun
    | undefined
}

export function updateCoordinatorRun(
  this: OrchestrationDb,
  id: string,
  status: CoordinatorStatus
): CoordinatorRun | undefined {
  const completedAt =
    status === 'completed' || status === 'failed' ? new Date().toISOString() : null
  this.db
    .prepare(
      'UPDATE coordinator_runs SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?'
    )
    .run(status, completedAt, id)
  return this.getCoordinatorRun(id)
}

export function getActiveCoordinatorRun(this: OrchestrationDb): CoordinatorRun | undefined {
  return this.db
    .prepare(
      "SELECT * FROM coordinator_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
    )
    .get() as CoordinatorRun | undefined
}

// ── Queries for Coordinator ──

export function getIdleTerminals(this: OrchestrationDb, excludeHandles: string[] = []): string[] {
  const active = this.db
    .prepare(
      "SELECT DISTINCT assignee_handle FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')"
    )
    .all() as { assignee_handle: string }[]
  const busyHandles = new Set(active.map((r) => r.assignee_handle))
  for (const h of excludeHandles) {
    busyHandles.add(h)
  }
  // Return handles from message history that aren't busy
  const allHandles = this.db
    .prepare(
      // Why: alias the UNION column — otherwise the row shape depends on the first branch's column name.
      'SELECT DISTINCT to_handle AS handle FROM messages UNION SELECT DISTINCT from_handle FROM messages'
    )
    .all() as { handle: string }[]
  return [...new Set(allHandles.map((r) => r.handle))].filter((h) => !busyHandles.has(h))
}

export type CoordinatorRunStoreMethods = {
  createCoordinatorRun: typeof createCoordinatorRun
  getCoordinatorRun: typeof getCoordinatorRun
  updateCoordinatorRun: typeof updateCoordinatorRun
  getActiveCoordinatorRun: typeof getActiveCoordinatorRun
  getIdleTerminals: typeof getIdleTerminals
}

export function attachCoordinatorRunStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createCoordinatorRun,
    getCoordinatorRun,
    updateCoordinatorRun,
    getActiveCoordinatorRun,
    getIdleTerminals
  })
}
