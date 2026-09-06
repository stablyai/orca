import type Database from '../../../sqlite/sync-database'
import { OrchestrationError } from '../orchestration-error'
import type { OrchestrationDb } from './orchestration-db'

/**
 * The single write boundary for Task, Dispatch, and supervised worker state.
 *
 * This function deliberately does not open or commit a transaction. Callers
 * often compose several projections (and a mailbox effect) in one transaction;
 * keeping the boundary neutral makes every projection atomic with that
 * caller-owned transaction.
 */
export type LifecycleEntity = 'task' | 'dispatch' | 'worker'

type LifecycleWriteTransaction = {
  savepoint: string | null
}

export function beginLifecycleWriteTransaction(
  db: Database.Database,
  savepoint: string
): LifecycleWriteTransaction {
  if (!/^[a-z][a-z0-9_]*$/.test(savepoint)) {
    throw new Error(`Invalid lifecycle savepoint: ${savepoint}`)
  }
  const nested = db.isTransaction
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  return { savepoint: nested ? savepoint : null }
}

export function commitLifecycleWriteTransaction(
  db: Database.Database,
  transaction: LifecycleWriteTransaction
): void {
  db.exec(transaction.savepoint ? `RELEASE ${transaction.savepoint}` : 'COMMIT')
}

export function rollbackLifecycleWriteTransaction(
  db: Database.Database,
  transaction: LifecycleWriteTransaction
): void {
  if (transaction.savepoint) {
    db.exec(`ROLLBACK TO ${transaction.savepoint}`)
    db.exec(`RELEASE ${transaction.savepoint}`)
    return
  }
  db.exec('ROLLBACK')
}

export type LifecycleTransitionParams = {
  entity: LifecycleEntity
  id: string
  from: string | readonly string[]
  to: string
  /** Additional legacy projection columns written with the state change. */
  projection?: Record<string, string | number | null>
  /** Narrow exception for a worker report correcting an unobserved prompt start. */
  correction?: 'unobserved_prompt_report'
}

const ENTITY_TABLE: Record<LifecycleEntity, { table: string; id: string; state: string }> = {
  task: { table: 'tasks', id: 'id', state: 'status' },
  dispatch: { table: 'dispatch_contexts', id: 'id', state: 'status' },
  worker: { table: 'worker_dispatches', id: 'dispatch_id', state: 'state' }
}

const TASK_STATUSES = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'] as const

/** Explicit lifecycle graph; Dispatch and worker terminal states have no outgoing edges. */
const LEGAL_TRANSITIONS: Record<LifecycleEntity, Record<string, readonly string[]>> = {
  task: {
    // Public taskUpdate accepts every status; its caller enforces active-Dispatch invariants.
    pending: TASK_STATUSES,
    ready: TASK_STATUSES,
    dispatched: TASK_STATUSES,
    blocked: TASK_STATUSES,
    completed: TASK_STATUSES,
    failed: TASK_STATUSES
  },
  dispatch: {
    pending: ['pending', 'dispatched', 'completed', 'failed', 'circuit_broken'],
    dispatched: ['dispatched', 'completed', 'failed', 'circuit_broken'],
    completed: ['completed'],
    failed: ['failed'],
    circuit_broken: ['circuit_broken']
  },
  worker: {
    starting: ['starting', 'ready', 'start_unknown', 'failed', 'stopping', 'stopped', 'abandoned'],
    start_unknown: ['start_unknown', 'ready', 'failed', 'stopping', 'stopped', 'abandoned'],
    ready: ['ready', 'succeeded', 'failed', 'stopping', 'abandoned'],
    stopping: ['stopping', 'stopped', 'stop_unknown', 'ready', 'failed', 'abandoned'],
    stop_unknown: ['stop_unknown', 'failed', 'stopped', 'abandoned'],
    succeeded: ['succeeded'],
    failed: ['failed'],
    stopped: ['stopped'],
    abandoned: ['abandoned']
  }
}

// Keep this allow-list narrow: projection values are bound parameters, while
// column names are interpolated into SQL.
const PROJECTION_COLUMNS = new Set([
  'result',
  'completed_at',
  'last_failure',
  'failure_count',
  'capability_revoked_at',
  'termination_reason',
  'stage',
  'worktree_id',
  'agent_terminal_handle',
  'setup_state',
  'effects',
  'residual_resources',
  'last_error',
  'updated_at',
  'runtime_epoch'
])

export function transitionLifecycle(
  this: OrchestrationDb,
  params: LifecycleTransitionParams
): { changed: boolean } {
  return transitionLifecycleWithDb(this.db, params)
}

/** DB-shaped variant used by low-level writers and tests. */
export function transitionLifecycleWithDb(
  db: Database.Database,
  params: LifecycleTransitionParams
): { changed: boolean } {
  const entity = ENTITY_TABLE[params.entity]
  const allowed = Array.isArray(params.from) ? params.from : [params.from]
  const current = db
    .prepare(`SELECT ${entity.state} AS state FROM ${entity.table} WHERE ${entity.id} = ?`)
    .get(params.id) as { state: string } | undefined
  if (!current) {
    throw new OrchestrationError(
      'lifecycle_not_found',
      `${params.entity} ${params.id} was not found.`,
      {
        entity: params.entity,
        id: params.id
      }
    )
  }
  if (!allowed.includes(current.state)) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `${params.entity} ${params.id} is ${current.state}; expected ${allowed.join(' or ')}.`,
      { entity: params.entity, id: params.id, state: current.state }
    )
  }
  const legal = LEGAL_TRANSITIONS[params.entity][current.state] ?? []
  const promptReportCorrection =
    params.correction === 'unobserved_prompt_report' &&
    current.state === 'failed' &&
    ((params.entity === 'task' && params.to === 'completed') ||
      (params.entity === 'dispatch' && params.to === 'completed') ||
      (params.entity === 'worker' && params.to === 'succeeded'))
  if (!legal.includes(params.to) && !promptReportCorrection) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `${params.entity} ${params.id} cannot transition from ${current.state} to ${params.to}.`,
      { entity: params.entity, id: params.id, state: current.state, to: params.to }
    )
  }

  const projection = Object.entries(params.projection ?? {})
  for (const [column] of projection) {
    if (!PROJECTION_COLUMNS.has(column)) {
      throw new Error(`Unsupported lifecycle projection column: ${column}`)
    }
  }
  const assignments = [`${entity.state} = ?`, ...projection.map(([column]) => `${column} = ?`)]
  const values: unknown[] = [
    params.to,
    ...projection.map(([, value]) => value),
    params.id,
    ...allowed
  ]
  const result = db
    .prepare(
      `UPDATE ${entity.table} SET ${assignments.join(', ')}
       WHERE ${entity.id} = ? AND ${entity.state} IN (${allowed.map(() => '?').join(', ')})`
    )
    .run(...(values as (string | number | bigint | null)[]))
  if (result.changes !== 1) {
    throw new OrchestrationError(
      'lifecycle_conflict',
      `${params.entity} ${params.id} changed while transitioning.`
    )
  }

  return { changed: true }
}

export type LifecycleTransitionMethods = {
  transitionLifecycle: typeof transitionLifecycle
}

export function attachLifecycleTransition(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { transitionLifecycle })
}
