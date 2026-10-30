import { createCrewRecipientInputs } from './crew-recipient-inputs'
import { captureCrewIdentityInputs } from './crew-identity-inputs'
import type { FleetDurableWorker } from '../../../../shared/orchestration-fleet-projection'
import { createFleetStatusIndex } from '../../../../shared/orchestration-fleet-status-index'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import { creatorFirstParent } from './crew-rules'
import { createCrewPartyRegistry, type Party } from './crew-parties'
import { readCrewAssignments, type CrewAssignmentRow } from './crew-query'
import { createCrewSourceInputs } from './crew-source-inputs'
import type { CrewReadDependencies } from './crew-read-model'

export function createCrewHostDerivation(deps: CrewReadDependencies, now: number) {
  const { statuses, ...sources } = captureCrewIdentityInputs(deps)
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
  const sourceInputs = createCrewSourceInputs(deps.db)
  return refreshCrewStatuses(
    {
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
      deps: { ...sources, statuses, records: registry.records },
      now,
      expiresAt,
      relations,
      workersById: new Map(workers.map((worker) => [worker.dispatchId, worker]))
    },
    statuses
  )
}

export function refreshCrewStatuses<
  T extends {
    deps: CrewReadDependencies
    workersById: Map<string, FleetDurableWorker>
  }
>(host: T, statuses: CrewReadDependencies['statuses']) {
  statuses = structuredClone(statuses)
  const statusIndex = createFleetStatusIndex(statuses, [...host.workersById.values()])
  const statusesByPane = new Map<string, (typeof statuses)[number]>()
  for (const status of statuses) {
    const prior = statusesByPane.get(status.activity.paneKey)
    if (!prior || status.deliveredAt > prior.deliveredAt) {
      statusesByPane.set(status.activity.paneKey, status)
    }
  }
  return { ...host, deps: { ...host.deps, statuses }, statusIndex, statusesByPane }
}

export type CrewHostDerivation = ReturnType<typeof createCrewHostDerivation>
