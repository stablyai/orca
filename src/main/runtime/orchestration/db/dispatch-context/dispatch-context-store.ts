import type { DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { CURRENT_CONTRACT_VERSION } from '../contract-constants'
import { generateId } from '../generated-id'
import { DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL, paneKeyMatchSuffix } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export const DISPATCH_CONTEXT_CLAIM_SQL = `INSERT INTO dispatch_contexts (
  id, run_id, task_id, contract_version, launch_token_hash,
  assignee_handle, assignee_pane_key, process_incarnation,
  status, failure_count, dispatched_at, requested_agent, base_agent
)
SELECT ?, run_id, id, ?, ?, ?, ?, ?, 'dispatched', ?, datetime('now'), ?, ?
FROM tasks
WHERE id = ? AND status = 'ready'
  AND NOT EXISTS (
    SELECT 1 FROM dispatch_contexts active
    WHERE active.assignee_handle = ?
      AND active.status IN ('pending', 'dispatched')
  )
  AND (
    ? IS NULL OR NOT EXISTS (
      SELECT 1 FROM dispatch_contexts active
      WHERE active.assignee_pane_key = ?
        AND active.status IN ('pending', 'dispatched')
    )
  )
  AND (
    ? IS NULL OR NOT EXISTS (
      SELECT 1 FROM dispatch_contexts active
      WHERE active.assignee_pane_key IS NOT NULL
        AND active.status IN ('pending', 'dispatched')
        AND instr(active.assignee_pane_key, ':') > 1
        AND ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ?
    )
  )`

export function createDispatchContext(
  this: OrchestrationDb,
  taskId: string,
  assigneeHandle: string,
  // Why: pane key is the remint-stable identity behind the handle — lets worker_done ownership survive handle reissue.
  assigneePaneKey?: string,
  launchTokenHashOrIdentity?: string | { requestedAgent: string | null; baseAgent: string | null },
  processIncarnation?: string,
  identityOverride?: { requestedAgent: string | null; baseAgent: string | null }
): DispatchContextRow {
  const launchTokenHash =
    typeof launchTokenHashOrIdentity === 'string' ? launchTokenHashOrIdentity : undefined
  const identity =
    typeof launchTokenHashOrIdentity === 'object' ? launchTokenHashOrIdentity : identityOverride
  const task = this.getTask(taskId)
  if (!task) {
    throw new Error(`Task not found: ${taskId}`)
  }
  if (task.status !== 'ready') {
    throw new Error(`Task ${taskId} is ${task.status}; only ready tasks can be dispatched`)
  }

  // Why: lock on pane identity too, so a reminted handle can't open a second concurrent dispatch on the same pane.
  const existing = this.findActiveDispatchForAssignee(assigneeHandle, assigneePaneKey)

  if (existing) {
    throw new Error(
      `Terminal ${assigneeHandle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
    )
  }

  // Carry forward failure_count so the circuit breaker accumulates across retries for the same task.
  const prior = this.db
    .prepare('SELECT MAX(failure_count) as max_failures FROM dispatch_contexts WHERE task_id = ?')
    .get(taskId) as { max_failures: number | null } | undefined
  const priorFailures = prior?.max_failures ?? 0

  const paneSuffix =
    assigneePaneKey && parsePaneKey(assigneePaneKey) ? paneKeyMatchSuffix(assigneePaneKey) : null
  const id = generateId('ctx')
  this.db.exec('SAVEPOINT create_dispatch_context')
  try {
    const inserted = this.db
      .prepare(DISPATCH_CONTEXT_CLAIM_SQL)
      .run(
        id,
        CURRENT_CONTRACT_VERSION,
        launchTokenHash ?? null,
        assigneeHandle,
        assigneePaneKey ?? null,
        processIncarnation ?? null,
        priorFailures,
        identity?.requestedAgent ?? null,
        identity?.baseAgent ?? null,
        taskId,
        assigneeHandle,
        assigneePaneKey ?? null,
        assigneePaneKey ?? null,
        paneSuffix,
        paneSuffix
      )
    if (inserted.changes !== 1) {
      const current = this.getTask(taskId)
      const occupied = this.findActiveDispatchForAssignee(assigneeHandle, assigneePaneKey)
      if (current?.status === 'ready' && occupied) {
        throw new Error(
          `Terminal ${assigneeHandle} already has an active dispatch (${occupied.id} for task ${occupied.task_id})`
        )
      }
      throw new Error(
        `Task ${taskId} is ${current?.status ?? 'missing'}; only ready tasks can be dispatched`
      )
    }
    this.db.prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ?").run(taskId)
    const dispatch = this.db
      .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
      .get(id) as DispatchContextRow
    this.db.exec('RELEASE create_dispatch_context')
    this.hasAnyDispatchContextsCache = true
    return dispatch
  } catch (error) {
    this.db.exec('ROLLBACK TO create_dispatch_context')
    this.db.exec('RELEASE create_dispatch_context')
    throw error
  }
}

export function getDispatchContext(
  this: OrchestrationDb,
  taskId: string
): DispatchContextRow | undefined {
  return this.db
    .prepare('SELECT * FROM dispatch_contexts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(taskId) as DispatchContextRow | undefined
}

export function getDispatchContextById(
  this: OrchestrationDb,
  dispatchId: string
): DispatchContextRow | undefined {
  return this.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(dispatchId) as
    | DispatchContextRow
    | undefined
}

export function commitDispatchLaunchTokenHash(
  this: OrchestrationDb,
  dispatchId: string,
  launchTokenHash: string
): DispatchContextRow {
  const dispatch = this.getDispatchContextById(dispatchId)
  if (!dispatch) {
    throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
  }
  if (dispatch.contract_version !== CURRENT_CONTRACT_VERSION) {
    throw new OrchestrationError(
      'request_mismatch',
      `Dispatch ${dispatchId} does not use the current contract.`
    )
  }
  if (dispatch.launch_token_hash && dispatch.launch_token_hash !== launchTokenHash) {
    throw new OrchestrationError(
      'request_mismatch',
      `Dispatch ${dispatchId} already has a different launch-token commitment.`
    )
  }
  this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET launch_token_hash = COALESCE(launch_token_hash, ?)
       WHERE id = ?`
    )
    .run(launchTokenHash, dispatchId)
  return this.getDispatchContextById(dispatchId) as DispatchContextRow
}

export type DispatchContextStoreMethods = {
  createDispatchContext: typeof createDispatchContext
  getDispatchContext: typeof getDispatchContext
  getDispatchContextById: typeof getDispatchContextById
  commitDispatchLaunchTokenHash: typeof commitDispatchLaunchTokenHash
}

export function attachDispatchContextStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createDispatchContext,
    getDispatchContext,
    getDispatchContextById,
    commitDispatchLaunchTokenHash
  })
}
