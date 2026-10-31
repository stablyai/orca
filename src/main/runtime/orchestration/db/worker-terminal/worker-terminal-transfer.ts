import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  isEquivalentPaneKey,
  paneKeyMatchSuffix
} from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'

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

type PaneHolder = {
  id: string
  pane: string | null
  incarnation: string | null
  status: string
  host: string | null
  acquired: number | null
  origin: string | null
  prior: string | null
  provenance: string | null
}

// Custody rows are inserted when a Dispatch acquires its pane and never reminted, so a pane's original-acquisition rows in
// rowid order are its holders in acquisition order. Backfilled and transferred rows carry no such order. A table rebuild
// that renumbers rowids must keep this order or retire this proof. Both host cohorts are read: an unknown host is not
// another host.
const PANE_HOLDERS_SQL = `WITH holders AS (
    SELECT * FROM dispatch_contexts WHERE ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ? AND host_scope = ?
    UNION ALL
    SELECT * FROM dispatch_contexts WHERE ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ? AND host_scope IS NULL
  )
  SELECT h.id, h.assignee_pane_key AS pane, h.process_incarnation AS incarnation, h.status,
         h.host_scope AS host, r.rowid AS acquired, r.origin_dispatch_id AS origin,
         r.prior_owner_dispatch_ids AS prior, r.retained_reason AS provenance
    FROM holders h LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = h.id`

/** For one caller check: the settled Dispatch that held an external pane's same process right before a resource's owner.
 *  Each pane's history is read and ordered once per lookup; the previous holder is never skipped for an older one. */
export function externalHolderLookup(
  db: OrchestrationDb
): (resource: WorkerTerminalResourceRow) => string | undefined {
  const histories = new Map<string, Map<string, PaneHolder | undefined> | null>()
  return (resource) => {
    const { pane_key: paneKey, process_incarnation: incarnation, host_scope: host } = resource
    const owner = resource.owner_dispatch_id
    if (resource.ownership_state !== 'external' || resource.origin_dispatch_id !== owner) {
      return undefined
    }
    // An unknown host or identity proves no adjacency.
    if (!paneKey || !incarnation || !host) {
      return undefined
    }
    const key = JSON.stringify([parsePaneKey(paneKey)?.leafId ?? paneKey, host])
    if (!histories.has(key)) {
      histories.set(key, orderPaneHolders(db, paneKey, host))
    }
    const previous = histories.get(key)?.get(owner)
    return previous?.incarnation === incarnation &&
      !['pending', 'dispatched'].includes(previous.status)
      ? previous.id
      : undefined
  }
}

/** Each holder's predecessor on the pane, or null when any holder's place in the order is unproven. */
function orderPaneHolders(
  db: OrchestrationDb,
  paneKey: string,
  host: string
): Map<string, PaneHolder | undefined> | null {
  const suffix = paneKeyMatchSuffix(paneKey)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly PaneHolder's columns.
  const holders = (
    db.db.prepare(PANE_HOLDERS_SQL).all(suffix, host, suffix) as PaneHolder[]
  ).filter((holder) => holder.pane !== null && isEquivalentPaneKey(holder.pane, paneKey))
  const ordered = holders.filter(
    (holder) =>
      holder.host === host &&
      holder.origin === holder.id &&
      holder.prior === '[]' &&
      holder.provenance !== 'legacy_ambiguous'
  )
  if (ordered.length !== holders.length) {
    return null
  }
  ordered.sort((a, b) => (a.acquired ?? 0) - (b.acquired ?? 0))
  return new Map(ordered.map((holder, index) => [holder.id, ordered[index - 1]]))
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
