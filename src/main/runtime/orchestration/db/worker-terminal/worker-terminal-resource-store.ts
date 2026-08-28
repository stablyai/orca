import type {
  WorkerTerminalResourceRow,
  WorkerTerminalOwnershipState
} from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

// --- Worker terminal resources (schema v23) ---------------------------------------------------

// Historical renderer input and reuse cannot be proven, so pre-v23 terminals stay external.
export function backfillWorkerTerminalResources(this: OrchestrationDb): void {
  const rows = this.db
    .prepare(
      `SELECT w.dispatch_id, w.worktree_id, w.agent_terminal_handle,
              d.assignee_pane_key, d.process_incarnation
         FROM worker_dispatches w
         JOIN dispatch_contexts d ON d.id = w.dispatch_id
        WHERE w.agent_terminal_handle IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM federated_dispatches f WHERE f.dispatch_id = w.dispatch_id)
          AND NOT EXISTS (
            SELECT 1 FROM worker_terminal_resources r WHERE r.owner_dispatch_id = w.dispatch_id
          )`
    )
    .all() as {
    dispatch_id: string
    worktree_id: string | null
    agent_terminal_handle: string
    assignee_pane_key: string | null
    process_incarnation: string | null
  }[]
  const insert = this.db.prepare(
    `INSERT INTO worker_terminal_resources (
       id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle,
       pane_key, process_incarnation, ownership_state, release_state, retained_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const row of rows) {
    insert.run(
      generateId('wtr'),
      row.dispatch_id,
      row.dispatch_id,
      row.worktree_id,
      row.agent_terminal_handle,
      row.assignee_pane_key,
      row.process_incarnation,
      'external',
      'retained',
      'legacy_ambiguous'
    )
  }
}

// No transaction: composes inside worker-start's authority transaction.
export function createWorkerTerminalResourceStatement(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    worktreeId: string | null
    terminalHandle: string
    paneKey: string | null
    processIncarnation: string | null
    hostScope?: string | null
    ownership: Extract<WorkerTerminalOwnershipState, 'owned' | 'external'>
  }
): WorkerTerminalResourceRow {
  const id = generateId('wtr')
  this.db
    .prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle,
         pane_key, process_incarnation, host_scope, ownership_state, release_state,
         retained_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_requested', ?)`
    )
    .run(
      id,
      params.dispatchId,
      params.dispatchId,
      params.worktreeId,
      params.terminalHandle,
      params.paneKey,
      params.processIncarnation,
      params.hostScope ?? null,
      params.ownership,
      params.ownership === 'external' ? 'external_terminal' : null
    )
  return this.getWorkerTerminalResource(id) as WorkerTerminalResourceRow
}

export function getWorkerTerminalResource(
  this: OrchestrationDb,
  id: string
): WorkerTerminalResourceRow | undefined {
  return this.db.prepare('SELECT * FROM worker_terminal_resources WHERE id = ?').get(id) as
    | WorkerTerminalResourceRow
    | undefined
}

export function getWorkerTerminalResourceByOwner(
  this: OrchestrationDb,
  dispatchId: string
): WorkerTerminalResourceRow | undefined {
  return this.db
    .prepare('SELECT * FROM worker_terminal_resources WHERE owner_dispatch_id = ?')
    .get(dispatchId) as WorkerTerminalResourceRow | undefined
}

export function getWorkerTerminalResourceFormerlyOwnedBy(
  this: OrchestrationDb,
  dispatchId: string
): WorkerTerminalResourceRow | undefined {
  return this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE prior_owner_dispatch_ids LIKE ?
        ORDER BY updated_at DESC LIMIT 1`
    )
    .get(`%"${dispatchId}"%`) as WorkerTerminalResourceRow | undefined
}

// Reusable exact settled terminal: transfers cleanup ownership to the new Dispatch and fences
// release through the old owner. No transaction: composes inside the authority transaction.
export function transferWorkerTerminalResourceStatement(
  this: OrchestrationDb,
  params: {
    resourceId: string
    toDispatchId: string
    terminalHandle: string
    paneKey: string
    processIncarnation: string
    hostScope: string | null
  }
): WorkerTerminalResourceRow {
  const resource = this.getWorkerTerminalResource(params.resourceId)
  if (!resource) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Worker terminal resource ${params.resourceId} was not found.`
    )
  }
  const priorOwners = JSON.parse(resource.prior_owner_dispatch_ids) as string[]
  priorOwners.push(resource.owner_dispatch_id)
  this.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET owner_dispatch_id = ?, prior_owner_dispatch_ids = ?, release_state = 'not_requested',
           retained_reason = NULL, release_requested_at = NULL, release_completed_at = NULL,
           release_error = NULL, terminal_handle = ?, pane_key = ?, process_incarnation = ?,
           host_scope = ?, updated_at = datetime('now')
       WHERE id = ? AND ownership_state = 'owned'`
    )
    .run(
      params.toDispatchId,
      JSON.stringify(priorOwners),
      params.terminalHandle,
      params.paneKey,
      params.processIncarnation,
      params.hostScope,
      params.resourceId
    )
  return this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
}

// Finds an owned, settled, exact-match resource for an explicitly reused terminal.

export type WorkerTerminalResourceStoreMethods = {
  backfillWorkerTerminalResources: typeof backfillWorkerTerminalResources
  createWorkerTerminalResourceStatement: typeof createWorkerTerminalResourceStatement
  getWorkerTerminalResource: typeof getWorkerTerminalResource
  getWorkerTerminalResourceByOwner: typeof getWorkerTerminalResourceByOwner
  getWorkerTerminalResourceFormerlyOwnedBy: typeof getWorkerTerminalResourceFormerlyOwnedBy
  transferWorkerTerminalResourceStatement: typeof transferWorkerTerminalResourceStatement
}

export function attachWorkerTerminalResourceStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    backfillWorkerTerminalResources,
    createWorkerTerminalResourceStatement,
    getWorkerTerminalResource,
    getWorkerTerminalResourceByOwner,
    getWorkerTerminalResourceFormerlyOwnedBy,
    transferWorkerTerminalResourceStatement
  })
}
