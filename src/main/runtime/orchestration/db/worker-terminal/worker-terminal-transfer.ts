import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import { isEquivalentPaneKey, parseWorkerTerminalPriorOwnerIds } from '../pane-key-match'
import type { DispatchContextRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

// Finds an owned, settled, exact-match resource for an explicitly reused terminal.
export function findTransferableWorkerTerminalResource(
  this: OrchestrationDb,
  params: {
    terminalHandle: string
    paneKey: string | null
    processIncarnation: string | null
    hostScope: string | null
  }
): WorkerTerminalResourceRow | undefined {
  if (!params.paneKey || !params.processIncarnation) {
    return undefined
  }
  const candidates = this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ?
          AND ownership_state != 'released'`
    )
    .all(params.processIncarnation, params.hostScope) as WorkerTerminalResourceRow[]
  const exact = candidates.filter(
    (candidate) =>
      candidate.pane_key &&
      params.paneKey &&
      isEquivalentPaneKey(candidate.pane_key, params.paneKey) &&
      candidate.process_incarnation === params.processIncarnation &&
      candidate.host_scope === params.hostScope
  )
  if (
    exact.some((candidate) =>
      ['requested', 'releasing', 'unknown'].includes(candidate.release_state)
    )
  ) {
    throw new OrchestrationError(
      'terminal_release_in_progress',
      `Terminal ${params.terminalHandle} has a release in progress; wait for cleanup or use another terminal.`
    )
  }
  return exact.find(
    (candidate) =>
      candidate.ownership_state === 'owned' &&
      ['not_requested', 'retained'].includes(candidate.release_state) &&
      ['succeeded', 'failed', 'stopped', 'abandoned'].includes(
        this.getWorkerDispatch(candidate.owner_dispatch_id)?.state ??
          this.getRemoteDispatchAttachment(candidate.owner_dispatch_id)?.state ??
          ''
      )
  )
}

/** The pane and process a new Dispatch would claim, as its custody row records them. */
export type NewWorkAssignee = {
  assigneeHandle: string
  assigneePaneKey?: string
  processIncarnation?: string
  hostScope?: string | null
}

/** Why a terminal or chat cannot take new work now: an active Dispatch on it or its pane (handle remint
 * cannot dodge that), or a finished Dispatch's custody that only worker-start transfers. */
function newWorkRefusal(
  db: OrchestrationDb,
  assignee: NewWorkAssignee,
  taskId: string
): Error | null {
  const { assigneeHandle, assigneePaneKey } = assignee
  const existing = db.findActiveDispatchForAssignee(assigneeHandle, assigneePaneKey)
  if (existing) {
    return new Error(
      `Terminal ${assigneeHandle} already has an active dispatch (${existing.id} for task ${existing.task_id})`
    )
  }
  let held: WorkerTerminalResourceRow | undefined
  try {
    held =
      assigneePaneKey && assignee.processIncarnation
        ? db.findTransferableWorkerTerminalResource({
            terminalHandle: assigneeHandle,
            paneKey: assigneePaneKey,
            processIncarnation: assignee.processIncarnation,
            hostScope: assignee.hostScope ?? null
          })
        : undefined
  } catch (error) {
    if (error instanceof OrchestrationError) {
      return error
    }
    throw error
  }
  return held
    ? new OrchestrationError(
        'invalid_argument',
        `Terminal ${assigneeHandle} is still held by finished Dispatch ${held.owner_dispatch_id}. Start this Task on it with \`orca orchestration worker-start --task ${taskId} --terminal ${assigneeHandle}\`.`
      )
    : null
}

export function assertTakesNewWork(
  db: OrchestrationDb,
  assignee: NewWorkAssignee,
  taskId: string
): void {
  const refusal = newWorkRefusal(db, assignee, taskId)
  if (refusal) {
    throw refusal
  }
}

/** The same rule as a census filter, so the coordinator never selects what dispatch refuses. */
export function takesNewWork(db: OrchestrationDb, assignee: NewWorkAssignee): boolean {
  return newWorkRefusal(db, assignee, '<task_id>') === null
}

export function workerTerminalResourceHasIdentityConflict(
  this: OrchestrationDb,
  resourceId: string
): boolean {
  const resource = this.getWorkerTerminalResource(resourceId)
  if (!resource?.pane_key || !resource.process_incarnation) {
    return true
  }
  const candidates = this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE process_incarnation = ? AND host_scope IS ?
          AND id != ? AND ownership_state != 'released'`
    )
    .all(
      resource.process_incarnation,
      resource.host_scope,
      resource.id
    ) as WorkerTerminalResourceRow[]
  return candidates.some(
    (candidate) =>
      candidate.pane_key &&
      isEquivalentPaneKey(candidate.pane_key, resource.pane_key as string) &&
      candidate.process_incarnation === resource.process_incarnation &&
      candidate.host_scope === resource.host_scope
  )
}

/** Every resource whose process incarnation starts with `prefix`, newest first. */
export function listWorkerTerminalResourcesByIncarnationPrefix(
  this: OrchestrationDb,
  prefix: string
): WorkerTerminalResourceRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
  return this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE substr(process_incarnation, 1, ?) = ? ORDER BY updated_at DESC`
    )
    .all(prefix.length, prefix) as WorkerTerminalResourceRow[]
}

const IDENTITY_COHORT_SQL =
  'SELECT * FROM worker_terminal_resources WHERE process_incarnation = ? AND host_scope IS ?'

type OwnerHistory = Map<string, string | undefined>

/** For one caller check: who held a Dispatch's exact terminal process right before it, from saved custody only. Each
 *  owner history and identity cohort is read and decoded at most once per check; it is evidence, never permission, and
 *  goes when the check does. */
export function previousCustodianLookup(
  db: OrchestrationDb
): (dispatch: DispatchContextRow) => string | undefined {
  const histories = new Map<string, OwnerHistory | null>()
  // Per exact process: each former holder's one custody row, or null when several rows name it.
  const cohorts = new Map<string, Map<string, WorkerTerminalResourceRow | null>>()
  // Each holder's predecessor in the row's ordered owners; unreadable or repeating history proves nothing.
  const historyOf = (resource: WorkerTerminalResourceRow) => {
    if (!histories.has(resource.id)) {
      const prior = parseWorkerTerminalPriorOwnerIds(resource.prior_owner_dispatch_ids)
      const owners = prior && [...prior, resource.owner_dispatch_id]
      const previous = owners && new Map(owners.map((owner, index) => [owner, owners[index - 1]]))
      histories.set(resource.id, previous?.size === owners?.length ? previous : null)
    }
    return histories.get(resource.id)
  }
  const cohortOf = (incarnation: string, host: string | null) => {
    const key = JSON.stringify([incarnation, host])
    let holders = cohorts.get(key)
    if (!holders) {
      holders = new Map()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
      const rows = db.db
        .prepare(IDENTITY_COHORT_SQL)
        .all(incarnation, host) as WorkerTerminalResourceRow[]
      for (const row of rows) {
        for (const holder of historyOf(row)?.keys() ?? []) {
          holders.set(holder, holders.has(holder) ? null : row)
        }
      }
      cohorts.set(key, holders)
    }
    return holders
  }
  return (dispatch) => {
    const resource =
      db.getWorkerTerminalResourceByOwner(dispatch.id) ??
      (dispatch.process_incarnation
        ? cohortOf(dispatch.process_incarnation, dispatch.host_scope).get(dispatch.id)
        : undefined)
    return resource ? historyOf(resource)?.get(dispatch.id) : undefined
  }
}

export type WorkerTerminalTransferMethods = {
  findTransferableWorkerTerminalResource: typeof findTransferableWorkerTerminalResource
  workerTerminalResourceHasIdentityConflict: typeof workerTerminalResourceHasIdentityConflict
  listWorkerTerminalResourcesByIncarnationPrefix: typeof listWorkerTerminalResourcesByIncarnationPrefix
}

export function attachWorkerTerminalTransfer(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    findTransferableWorkerTerminalResource,
    workerTerminalResourceHasIdentityConflict,
    listWorkerTerminalResourcesByIncarnationPrefix
  })
}
