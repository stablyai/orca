import { OrchestrationError } from '../orchestration-error'
import type {
  AttemptObservationFact,
  AttemptObservationFactInput,
  AttemptObservationFacet
} from './attempt-observation-types'
import type { OrchestrationDb } from './orchestration-db'

export type AttemptObservationStorageRow = {
  id: string
  dispatch_id: string
  task_id: string
  sequence: number
  authority_id: string
  authority_clock: 'execution' | 'home'
  facet: AttemptObservationFacet
  payload: string
  source_observed_at: number | null
  execution_received_at: number | null
  home_received_at: number
  created_at: string
}

function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPayload).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPayload(record[key])}`)
      .join(',')}}`
  }
  // JSON has no representation for undefined; preserve valid replayable JSON.
  return value === undefined ? 'null' : JSON.stringify(value)
}

export function exposeAttemptObservationFact(
  row: AttemptObservationStorageRow
): AttemptObservationFact {
  return {
    id: row.id,
    dispatchId: row.dispatch_id,
    taskId: row.task_id,
    sequence: row.sequence,
    authorityId: row.authority_id,
    authorityClock: row.authority_clock,
    facet: row.facet,
    payload: JSON.parse(row.payload),
    sourceObservedAt: row.source_observed_at,
    executionReceivedAt: row.execution_received_at,
    homeReceivedAt: row.home_received_at,
    createdAt: row.created_at
  } as AttemptObservationFact
}

function sameFact(row: AttemptObservationStorageRow, input: AttemptObservationFactInput): boolean {
  return (
    row.dispatch_id === input.dispatchId &&
    row.sequence === input.sequence &&
    row.authority_id === input.authorityId &&
    row.authority_clock === input.authorityClock &&
    row.facet === input.facet &&
    row.payload === canonicalPayload(input.payload) &&
    row.source_observed_at === (input.sourceObservedAt ?? null) &&
    row.execution_received_at === (input.executionReceivedAt ?? null) &&
    row.home_received_at === input.homeReceivedAt
  )
}

function validateInput(input: AttemptObservationFactInput): void {
  if (!input.id || !input.dispatchId || !input.authorityId) {
    throw new OrchestrationError('invalid_observation', 'Observation identity fields are required.')
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new OrchestrationError(
      'invalid_observation',
      'Observation sequence must be a non-negative integer.'
    )
  }
  for (const value of [input.sourceObservedAt, input.executionReceivedAt, input.homeReceivedAt]) {
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new OrchestrationError(
        'invalid_observation',
        'Observation timestamps must be non-negative.'
      )
    }
  }
}

export function recordAttemptObservation(
  this: OrchestrationDb,
  input: AttemptObservationFactInput
): { fact: AttemptObservationFact; duplicate: boolean } {
  validateInput(input)
  const existing = this.db
    .prepare('SELECT * FROM attempt_observation_facts WHERE id = ?')
    .get(input.id) as AttemptObservationStorageRow | undefined
  if (existing) {
    if (!sameFact(existing, input)) {
      throw new OrchestrationError(
        'observation_replay_conflict',
        `Observation ${input.id} was replayed with different content.`
      )
    }
    return { fact: exposeAttemptObservationFact(existing), duplicate: true }
  }
  const dispatch = this.getDispatchContextById(input.dispatchId)
  if (!dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${input.dispatchId} was not found.`
    )
  }
  const occupied = this.db
    .prepare('SELECT id FROM attempt_observation_facts WHERE dispatch_id = ? AND sequence = ?')
    .get(input.dispatchId, input.sequence) as { id: string } | undefined
  if (occupied) {
    throw new OrchestrationError(
      'observation_order_conflict',
      `Dispatch ${input.dispatchId} observation sequence ${input.sequence} is already ${occupied.id}.`
    )
  }
  this.db
    .prepare(
      `INSERT INTO attempt_observation_facts (
         id, dispatch_id, task_id, sequence, authority_id, authority_clock, facet, payload,
         source_observed_at, execution_received_at, home_received_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.dispatchId,
      dispatch.task_id,
      input.sequence,
      input.authorityId,
      input.authorityClock,
      input.facet,
      canonicalPayload(input.payload),
      input.sourceObservedAt ?? null,
      input.executionReceivedAt ?? null,
      input.homeReceivedAt
    )
  const row = this.db
    .prepare('SELECT * FROM attempt_observation_facts WHERE id = ?')
    .get(input.id) as AttemptObservationStorageRow
  return { fact: exposeAttemptObservationFact(row), duplicate: false }
}

export function getAttemptObservationFacts(
  this: OrchestrationDb,
  dispatchId: string
): AttemptObservationFact[] {
  return (
    this.db
      .prepare(
        'SELECT * FROM attempt_observation_facts WHERE dispatch_id = ? ORDER BY sequence, rowid'
      )
      .all(dispatchId) as AttemptObservationStorageRow[]
  ).map(exposeAttemptObservationFact)
}

/** A sibling attempt still running for the same Task. Both the outcome projection and the
 *  attention query must read the identical predicate or one reports an outcome the other calls
 *  unknown. `taskId`/`dispatchId` are SQL expressions the caller writes ('?' or a joined column),
 *  never user input. */
export function activeSiblingAttemptSql(taskId: string, dispatchId: string): string {
  return `SELECT 1 FROM dispatch_contexts active
     JOIN worker_dispatches sibling ON sibling.dispatch_id = active.id
     WHERE active.task_id = ${taskId} AND active.id != ${dispatchId}
       AND active.status IN ('pending', 'dispatched')
       AND sibling.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')`
}

export type AttemptObservationStoreMethods = {
  recordAttemptObservation: typeof recordAttemptObservation
  getAttemptObservationFacts: typeof getAttemptObservationFacts
}

export function attachAttemptObservationStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    recordAttemptObservation,
    getAttemptObservationFacts
  })
}
