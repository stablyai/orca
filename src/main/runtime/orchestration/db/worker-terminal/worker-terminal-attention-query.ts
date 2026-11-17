import { projectAttemptOutcome } from '../attempt-outcome-projection'
import {
  activeSiblingAttemptSql,
  exposeAttemptObservationFact,
  type AttemptObservationStorageRow
} from '../attempt-observation-store'
import type { AttemptProjectedOutcome } from '../attempt-observation-types'
import type { DispatchStatus, WorkerDispatchState } from '../orchestration-records'
import type { TerminalExitCause } from '../../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import type { OrchestrationDb } from '../orchestration-db'
import { ATTEMPT_OBSERVATION_FACT_COLUMN_LIST } from '../row-column-lists'

export type WorkerAttentionFacts = {
  outcome: AttemptProjectedOutcome
  pendingInput: boolean
  pendingGuidance: boolean
  pendingApproval: boolean
  terminationReason: TerminalExitCause['kind'] | null
  isRoot: boolean
  workerState: WorkerDispatchState | null
  workerStage: string | null
  dispatchStatus: DispatchStatus
  /** Execution host of the worker's terminal resource; a remote row with no connection id is
   *  unverifiable. `undefined` when no resource was ever materialized. */
  hostScope?: string | null
  /** A released resource is an execution-host confirmation that the terminal is gone. */
  releaseState?: string | null
}

type WorkerAttentionRow = {
  dispatch_id: string
  task_id: string
  dispatch_status: DispatchStatus
  termination_reason: TerminalExitCause['kind'] | null
  worker_state: WorkerDispatchState | null
  worker_stage: string | null
  parent_task_id: string | null
  resource_id: string | null
  host_scope: string | null
  release_state: string | null
  pending_input: number
  pending_approval: number
  pending_guidance: number
  active_sibling: number
}

export type WorkerAttentionInput = {
  row: WorkerAttentionRow
  observations: ReturnType<typeof exposeAttemptObservationFact>[]
}

export function readWorkerAttentionInputs(
  db: OrchestrationDb,
  dispatchIds: readonly string[]
): Map<string, WorkerAttentionInput> {
  const ids = [...new Set(dispatchIds)]
  if (ids.length === 0) {
    return new Map()
  }
  const serializedIds = JSON.stringify(ids)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects each schema-owned WorkerAttentionRow column.
  const rows = db.db
    .prepare(
      `SELECT d.id AS dispatch_id, d.task_id, d.status AS dispatch_status,
              d.termination_reason, w.state AS worker_state, w.stage AS worker_stage,
              t.parent_id AS parent_task_id,
              r.id AS resource_id, r.host_scope, r.release_state,
              EXISTS (
                SELECT 1 FROM question_threads q
                 WHERE q.dispatch_id = d.id AND q.status = 'pending'
              ) AS pending_input,
              EXISTS (
                SELECT 1 FROM decision_gates g
                 WHERE g.task_id = d.task_id AND g.status = 'pending'
              ) AS pending_approval,
              EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.run_id = d.run_id AND m.to_handle = 'dispatch:' || d.id
                   AND m.read = 0 AND m.delivery_contract = 'current_delivery'
              ) AS pending_guidance,
              EXISTS (${activeSiblingAttemptSql('d.task_id', 'd.id')}) AS active_sibling
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN tasks t ON t.id = d.task_id AND t.run_id = d.run_id
         LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
        WHERE d.id IN (SELECT value FROM json_each(?))`
    )
    .all(serializedIds) as WorkerAttentionRow[]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects the schema-owned observation column list.
  const observationRows = db.db
    .prepare(
      `SELECT ${ATTEMPT_OBSERVATION_FACT_COLUMN_LIST} FROM attempt_observation_facts
        WHERE rowid IN (
          SELECT (SELECT rowid FROM attempt_observation_facts
            WHERE dispatch_id = requested.value AND facet = facets.value
            ORDER BY sequence DESC LIMIT 1)
          FROM json_each(?) requested, json_each('["process_turn","artifact_git","worker_report","coordinator_ack","liveness","outcome"]') facets
        )
        ORDER BY dispatch_id, sequence, rowid`
    )
    .all(serializedIds) as AttemptObservationStorageRow[]
  const factsByDispatch = new Map<string, ReturnType<typeof exposeAttemptObservationFact>[]>()
  for (const observationRow of observationRows) {
    const facts = factsByDispatch.get(observationRow.dispatch_id) ?? []
    facts.push(exposeAttemptObservationFact(observationRow))
    factsByDispatch.set(observationRow.dispatch_id, facts)
  }
  return new Map(
    rows.map((row) => {
      const latest = new Map<string, ReturnType<typeof exposeAttemptObservationFact>>()
      for (const fact of factsByDispatch.get(row.dispatch_id) ?? []) {
        const previous = latest.get(fact.facet)
        if (!previous || previous.sequence < fact.sequence) {
          latest.set(fact.facet, fact)
        }
      }
      return [row.dispatch_id, { row, observations: [...latest.values()] }]
    })
  )
}

export function projectWorkerAttentionInput(
  input: WorkerAttentionInput,
  authorityNow: number
): WorkerAttentionFacts {
  const { row, observations } = input
  return {
    outcome: projectAttemptOutcome({
      dispatchId: row.dispatch_id,
      taskId: row.task_id,
      facts: observations,
      activeSibling: row.active_sibling === 1,
      authorityNow: { home: authorityNow }
    }).taskOutcome,
    pendingInput: row.pending_input === 1,
    pendingGuidance: row.pending_guidance === 1,
    pendingApproval: row.pending_approval === 1,
    terminationReason: row.termination_reason,
    isRoot: row.parent_task_id === null,
    workerState: row.worker_state,
    workerStage: row.worker_stage,
    dispatchStatus: row.dispatch_status,
    ...(row.resource_id === null
      ? {}
      : { hostScope: row.host_scope, releaseState: row.release_state })
  }
}

export function getWorkerAttentionFactsForDispatches(
  this: OrchestrationDb,
  dispatchIds: readonly string[],
  authorityNow: number
): Map<string, WorkerAttentionFacts> {
  return new Map(
    [...readWorkerAttentionInputs(this, dispatchIds)].map(([id, input]) => [
      id,
      projectWorkerAttentionInput(input, authorityNow)
    ])
  )
}

export function getWorkerAttentionFacts(
  this: OrchestrationDb,
  dispatchId: string,
  authorityNow: number
): WorkerAttentionFacts {
  const facts = this.getWorkerAttentionFactsForDispatches([dispatchId], authorityNow).get(
    dispatchId
  )
  if (!facts) {
    throw new Error(`Dispatch ${dispatchId} was not found.`)
  }
  return facts
}
