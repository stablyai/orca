import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  isEquivalentPaneKey,
  paneKeyMatchSuffix,
  parseWorkerTerminalPriorOwnerIds
} from '../pane-key-match'
import type { DispatchContextRow } from '../../types'
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
  /** Dispatch insertion order; never compared with custody rowids. */
  inserted: number
  supervised: 0 | 1
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
// rowid order are its holders in acquisition order. Backfilled and transferred rows carry no such order. A direct
// dispatch claims the pane in the Dispatch row it inserts (no worker row, no custody row), so it precedes any Dispatch
// inserted after it, and every acquisition by one. A table rebuild that renumbers either table's rowids must keep its
// order or retire this proof. Both host cohorts are read: an unknown host is not another host.
const PANE_HOLDERS_SQL = `WITH holders AS (
    SELECT rowid AS inserted, * FROM dispatch_contexts
     WHERE ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ? AND host_scope = ?
    UNION ALL
    SELECT rowid AS inserted, * FROM dispatch_contexts
     WHERE ${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL} = ? AND host_scope IS NULL
  )
  SELECT h.id, h.inserted, h.assignee_pane_key AS pane, h.process_incarnation AS incarnation,
         h.status, h.host_scope AS host, r.rowid AS acquired, r.origin_dispatch_id AS origin,
         r.prior_owner_dispatch_ids AS prior, r.retained_reason AS provenance,
         EXISTS (SELECT 1 FROM worker_dispatches w WHERE w.dispatch_id = h.id) AS supervised
    FROM holders h LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = h.id`

/** A pane's acquisitions in order, and the latest direct claim's insertion, before which no edge may reach. */
type PaneOrder = { previous: Map<string, PaneHolder | undefined>; claimedBefore: number }

const IDENTITY_COHORT_SQL =
  'SELECT * FROM worker_terminal_resources WHERE process_incarnation = ? AND host_scope IS ?'

/** For one caller check: who held a Dispatch's exact terminal process right before it. Each custody cohort, history and
 *  pane order is read and decoded at most once per check; it is evidence, never permission, and goes when the check does. */
export function previousCustodianLookup(
  db: OrchestrationDb
): (dispatch: DispatchContextRow) => string | undefined {
  const cohorts = new Map<string, WorkerTerminalResourceRow[]>()
  const histories = new Map<string, Map<string, string | undefined> | null>()
  const panes = new Map<string, PaneOrder | null>()
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
  // An external pane is never transferred, so its earlier holder is the pane's previous assignment.
  const externalHolder = (resource: WorkerTerminalResourceRow) => {
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
    if (!panes.has(key)) {
      panes.set(key, orderPaneHolders(db, paneKey, host))
    }
    const order = panes.get(key)
    const previous = order?.previous.get(owner)
    // A direct claim inserted after the previous holder could sit between the two.
    return previous &&
      previous.inserted > order.claimedBefore &&
      previous.incarnation === incarnation &&
      !['pending', 'dispatched'].includes(previous.status)
      ? previous.id
      : undefined
  }
  return (dispatch) => {
    let resource = db.getWorkerTerminalResourceByOwner(dispatch.id)
    if (!resource && dispatch.process_incarnation) {
      // A former holder: its exact process's custody rows, kept only if their ordered owners name it.
      const key = JSON.stringify([dispatch.process_incarnation, dispatch.host_scope])
      let cohort = cohorts.get(key)
      if (!cohort) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table is exactly its row shape.
        cohort = db.db
          .prepare(IDENTITY_COHORT_SQL)
          .all(dispatch.process_incarnation, dispatch.host_scope) as WorkerTerminalResourceRow[]
        cohorts.set(key, cohort)
      }
      const held = cohort.filter((row) => historyOf(row)?.has(dispatch.id))
      resource = held.length === 1 ? held[0] : undefined
    }
    const history = resource && historyOf(resource)
    if (!resource || !history?.has(dispatch.id)) {
      return undefined
    }
    return history.get(dispatch.id) ?? externalHolder(resource)
  }
}

/** Each acquisition's predecessor on the pane and the latest direct claim, or null when any other holder's place in
 *  the order is unproven. */
function orderPaneHolders(db: OrchestrationDb, paneKey: string, host: string): PaneOrder | null {
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
  const claims = holders.filter((holder) => holder.acquired === null && !holder.supervised)
  if (ordered.length + claims.length !== holders.length) {
    return null
  }
  ordered.sort((a, b) => (a.acquired ?? 0) - (b.acquired ?? 0))
  return {
    previous: new Map(ordered.map((holder, index) => [holder.id, ordered[index - 1]])),
    claimedBefore: Math.max(0, ...claims.map((claim) => claim.inserted))
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
