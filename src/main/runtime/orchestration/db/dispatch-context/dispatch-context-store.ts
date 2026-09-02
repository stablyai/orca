import type { DispatchContextRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { CURRENT_CONTRACT_VERSION } from '../contract-constants'
import { generateId } from '../generated-id'
import { paneKeyMatchSuffix } from '../pane-key-match'
import { claimDispatchContextRow } from '../dispatch-row-writer'
import type { DispatchCreator } from '../dispatch-depth'
import type { OrchestrationDb } from '../orchestration-db'

export function createDispatchContext(
  this: OrchestrationDb,
  params: {
    taskId: string
    assigneeHandle: string
    // Why: pane key is the remint-stable identity behind the handle — lets worker_done ownership survive handle reissue.
    assigneePaneKey?: string
    launchTokenHash?: string
    processIncarnation?: string
    /** Who is dispatching, for nesting depth. Required so a new caller must decide. */
    creator: DispatchCreator
    maxDepth: number
  }
): DispatchContextRow {
  const { taskId, assigneeHandle, assigneePaneKey, launchTokenHash, processIncarnation } = params
  const depth = this.resolveChildDispatchDepth(params.creator, params.maxDepth)
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
    const inserted = claimDispatchContextRow(this.db, {
      id,
      contractVersion: CURRENT_CONTRACT_VERSION,
      launchTokenHash: launchTokenHash ?? null,
      assigneeHandle,
      assigneePaneKey: assigneePaneKey ?? null,
      processIncarnation: processIncarnation ?? null,
      priorFailures,
      depth,
      taskId,
      paneSuffix
    })
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
