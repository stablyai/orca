import { isDeepStrictEqual } from 'node:util'
import { createCrewRecipientInputs } from './crew-recipient-inputs'
import { captureCrewIdentityInputs } from './crew-identity-inputs'
import type { FleetDurableWorker } from '../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import { creatorFirstParent } from './crew-rules'
import { createCrewPartyRegistry, type Party } from './crew-parties'
import { readCrewAssignmentIds, readCrewAssignments, type CrewAssignmentRow } from './crew-query'
import { createCrewSourceInputs } from './crew-source-inputs'
import type { CrewReadDependencies } from './crew-read-dependencies'
import { CrewStatusRows } from './crew-status-rows'
import { crewShownBindings, type CrewRelevance } from './crew-changes'

/** A host's captured inputs; its status rows live in `statuses`, which status wakes update in place. */
export type CrewHostDeps = Omit<CrewReadDependencies, 'statuses'>

export function createCrewHostDerivation(deps: CrewReadDependencies, capacity?: () => number) {
  const { statuses, ...sources } = captureCrewIdentityInputs(deps)
  // Reading statuses can refresh the same source; capture its cutoff afterwards.
  const now = deps.now ?? Date.now()
  const registry = createCrewPartyRegistry({ ...sources, statuses })
  const { alias } = registry
  const identity = deps.openIdentityRead?.()
  const party: typeof registry.party = (session, handle, pane, fallback, process) =>
    registry.party(session, handle, pane, fallback, process, identity)
  const selected = (rows: CrewAssignmentRow[]) =>
    rows.sort(
      (a, b) =>
        Number(['pending', 'dispatched'].includes(b.status)) -
          Number(['pending', 'dispatched'].includes(a.status)) || b.ordinal - a.ordinal
    )
  const assignments = deps.db ? [...selected(readCrewAssignments(deps.db, now))] : []
  const assignmentsById = new Map(assignments.map((row) => [row.id, row]))
  const assignmentParty = new Map<string, Party>()
  const addAssignment = (row: CrewAssignmentRow): Party => {
    const worker = party(
      row.assignee_orca_session_id,
      row.assignee_handle,
      row.assignee_pane_key,
      `dispatch:${row.id}`,
      row.assignee_process
    )!
    assignmentParty.set(row.id, worker)
    alias(`dispatch:${row.id}`, worker.address)
    return worker
  }
  const coordinator = (row: CrewAssignmentRow) =>
    party(
      row.coordinator_session,
      row.coordinator_handle,
      row.coordinator_pane_key,
      `run:${row.run_id}`
    )
  for (const row of assignments) {
    addAssignment(row)
    const manager = coordinator(row)
    if (manager) {
      alias(`run:${row.run_id}`, manager.address)
    }
    party(row.creator_orca_session_id, row.creator_handle, row.creator_pane_key)
  }
  const relations = new Map<
    string,
    {
      assignment: CrewAssignmentRow
      worker: Party
      parent: Party
      parentAssignment: CrewAssignmentRow | undefined
      parentAddress: string
    }[]
  >()
  const selectedWorkers = new Set<string>()
  for (const assignment of assignments) {
    const worker = assignmentParty.get(assignment.id)!
    if (selectedWorkers.has(worker.address)) {
      continue
    }
    selectedWorkers.add(worker.address)
    const creator =
      (assignment.creator_dispatch_id
        ? assignmentParty.get(assignment.creator_dispatch_id)
        : undefined) ??
      party(
        assignment.creator_orca_session_id,
        assignment.creator_handle,
        assignment.creator_pane_key
      )
    const manager = coordinator(assignment)
    const parent = creatorFirstParent(
      creator?.address === worker.address ? undefined : creator,
      manager,
      manager?.address === worker.address
    )
    if (!parent || parent.address === worker.address) {
      continue
    }
    const parentAssignment = assignment.creator_dispatch_id
      ? assignmentsById.get(assignment.creator_dispatch_id)
      : undefined
    const relation = {
      assignment,
      worker,
      parent,
      parentAssignment,
      parentAddress:
        creator?.address === parent.address
          ? parentAssignment
            ? `dispatch:${parentAssignment.id}`
            : parent.address
          : `run:${assignment.run_id}`
    }
    for (const address of [worker.address, parent.address]) {
      const edges = relations.get(address) ?? []
      edges.push(relation)
      relations.set(address, edges)
    }
  }
  const workers: FleetDurableWorker[] = assignments.map((row) => ({
    dispatchId: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    parentTaskId: null,
    workerState: 'unsupervised',
    dispatchStatus: row.status,
    workerStage: row.stage,
    agentTerminalHandle: row.assignee_handle,
    paneKey: row.assignee_pane_key,
    worktreeId: null,
    terminalState: null,
    resource: row.resource_incarnation
      ? {
          id: row.id,
          ownerDispatchId: row.id,
          worktreeId: null,
          paneKey: row.assignee_pane_key,
          processIncarnation: row.resource_incarnation,
          hostScope: row.resource_host_scope,
          ownershipState: 'owned',
          releaseState: 'live',
          updatedAt: ''
        }
      : null
  }))
  let expiresAt = Infinity
  for (const row of assignments) {
    if (row.completed_at) {
      const completed = Date.parse(
        row.completed_at.includes('T') ? row.completed_at : `${row.completed_at.replace(' ', 'T')}Z`
      )
      if (Number.isFinite(completed)) {
        expiresAt = Math.min(expiresAt, completed + AGENT_STATUS_STALE_AFTER_MS + 1)
      }
    }
  }
  const sourceInputs = createCrewSourceInputs(deps.db, capacity)
  const hostDeps: CrewHostDeps = { ...sources, records: registry.records }
  return {
    registry,
    sourceInputs,
    recipientInputs: deps.db
      ? createCrewRecipientInputs(
          deps.db,
          registry.records,
          registry.commandCanonical,
          sourceInputs.legacyOwner
        )
      : null,
    deps: hostDeps,
    now,
    expiresAt,
    relations,
    assignmentsById,
    workersById: new Map(workers.map((worker) => [worker.dispatchId, worker])),
    statuses: new CrewStatusRows(statuses, workers)
  }
}

/** Rereads only `panes`' status rows, or every row when undefined; a row that moves a shown binding rebuilds. */
export function refreshCrewStatuses(
  previous: CrewHostDerivation,
  deps: CrewReadDependencies,
  panes: ReadonlySet<string> | undefined,
  relevance: CrewRelevance | undefined,
  rebuild: (deps: CrewReadDependencies) => CrewHostDerivation
): CrewHostDerivation {
  const sameShown = (before: CrewReadDependencies['statuses'], after: typeof before) =>
    isDeepStrictEqual(crewShownBindings(before, relevance), crewShownBindings(after, relevance))
  // Under a fresh identity capture any row may resolve differently: reread them all.
  if (
    panes &&
    deps.statusesForPanes &&
    deps.openRuntimeIdentityRead === previous.deps.openRuntimeIdentityRead
  ) {
    const after = deps.statusesForPanes(panes)
    if (sameShown(previous.statuses.rowsOf(panes), after)) {
      previous.statuses.replace(panes, after)
      return previous
    }
  }
  const { statuses, ...sources } = deps
  return sameShown(previous.statuses.statuses, statuses)
    ? { ...previous, statuses: new CrewStatusRows(statuses, [...previous.workersById.values()]) }
    : rebuild({ ...sources, records: previous.deps.records, statuses })
}

/** Replaces assignment rows whose only change is their stage; null when any changed more, which needs a rebuild. */
export function patchCrewAssignmentStages(
  host: CrewHostDerivation,
  ids: ReadonlySet<string>
): CrewHostDerivation | null {
  if (!host.deps.db) {
    return host
  }
  const rows = readCrewAssignmentIds(host.deps.db, [...ids])
  const byId = new Map(rows.map((row) => [row.id, row]))
  const changed = new Map<string, CrewAssignmentRow>()
  for (const id of ids) {
    const before = host.assignmentsById.get(id)
    const after = byId.get(id)
    if (!before) {
      // Not among the host's assignments: shown nowhere unless it now qualifies, which only a rebuild knows.
      if (after) {
        return null
      }
      continue
    }
    if (!after || !sameExceptStage(before, after)) {
      return null
    }
    if (after.stage !== before.stage) {
      changed.set(id, after)
    }
  }
  if (changed.size === 0) {
    return host
  }
  const swap = (row: CrewAssignmentRow | undefined) => (row && changed.get(row.id)) ?? row
  const relations = new Map(
    [...host.relations].map(([address, edges]) => [
      address,
      edges.map((edge) =>
        changed.has(edge.assignment.id) ||
        (edge.parentAssignment && changed.has(edge.parentAssignment.id))
          ? {
              ...edge,
              assignment: swap(edge.assignment)!,
              parentAssignment: swap(edge.parentAssignment)
            }
          : edge
      )
    ])
  )
  const workersById = new Map(host.workersById)
  for (const [id, row] of changed) {
    const worker = workersById.get(id)
    if (worker) {
      workersById.set(id, { ...worker, workerStage: row.stage })
    }
  }
  const assignmentsById = new Map(host.assignmentsById)
  for (const [id, row] of changed) {
    assignmentsById.set(id, row)
  }
  host.sourceInputs.replaceAssignments(changed.values())
  // A stage is no part of a worker's identity: the status index stands.
  return { ...host, relations, workersById, assignmentsById }
}

function sameExceptStage(a: CrewAssignmentRow, b: CrewAssignmentRow): boolean {
  const { stage: _aStage, ...aRest } = a
  const { stage: _bStage, ...bRest } = b
  return isDeepStrictEqual(aRest, bRest)
}

export type CrewHostDerivation = ReturnType<typeof createCrewHostDerivation>
