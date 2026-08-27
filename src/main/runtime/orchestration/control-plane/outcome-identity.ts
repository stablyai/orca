import { createHash } from 'node:crypto'
import type { ControlPlaneStore, OutcomeRelationRow, OutcomeRow } from './control-plane-store'
import { findSerializationDeadlock } from './outcome-relation-deadlock'

/** B2 — one business outcome, one durable Run.
 *
 *  State machine (one row per outcome):
 *    trigger                immediate state   writer          next state
 *    -----------------------------------------------------------------------
 *    admitOutcome           admitted          admitOutcome    closed
 *    duplicate admit        admitted          admitOutcome    admitted (no-op)
 *    conflicting admit      unchanged         admitOutcome    rejected error
 *  Transaction boundary: the caller wraps admitOutcome together with the Run
 *  write it guards, so a rejected admission leaves no Run bound. Idempotency
 *  scope: the (outcomeId, runId) pair — replaying the identical admission is a
 *  no-op, any other pairing is a bounded rejection, never a silent rebind.
 *  Crash recovery: the UNIQUE(run_id) index is the durable arbiter; a crash
 *  between insert and Run write leaves an outcome whose replay is a no-op.
 */

export const MIN_OUTCOME_INTAKE = 2
export const MAX_OUTCOME_INTAKE = 5

export type OutcomeGatePolicy = 'standard' | 'high_risk'

export type OutcomeAdmissionRequest = {
  outcomeId: string
  runId: string
  title: string
  /** Stable content identity of the business outcome, not of the Run. */
  fingerprint: string
  intakeBatch?: string | null
  gatePolicy?: OutcomeGatePolicy
}

export type OutcomeAdmissionCode =
  | 'run_bound_to_other_outcome'
  | 'outcome_bound_to_other_run'
  | 'fingerprint_conflict'
  | 'intake_size_invalid'
  | 'duplicate_outcome_id'
  | 'duplicate_run_id'
  | 'unknown_run'
  | 'batch_manifest_conflict'
  | 'relation_decision_conflict'
  | 'undecided_relation'
  | 'self_serialized_outcome'
  | 'serialized_with_merged_outcome'

export type OutcomeAdmissionError = {
  code: OutcomeAdmissionCode
  outcomeId: string
  runId: string
  reason: string
}

export type OutcomeAdmission =
  | { ok: true; outcome: OutcomeRow; duplicate: boolean }
  | { ok: false; error: OutcomeAdmissionError }

/** Domain separator for fingerprint fields: a byte that cannot occur in any
 *  field, written as an escape so this file never classifies as binary. */
const FIELD_SEPARATOR = '\u0000'

export function outcomeFingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(FIELD_SEPARATOR)).digest('hex').slice(0, 32)
}

export function admitOutcome(
  store: ControlPlaneStore,
  request: OutcomeAdmissionRequest
): OutcomeAdmission {
  const reject = (code: OutcomeAdmissionCode, reason: string): OutcomeAdmission => ({
    ok: false,
    error: { code, outcomeId: request.outcomeId, runId: request.runId, reason }
  })

  const byRun = store.getOutcomeByRun(request.runId)
  const byOutcome = store.getOutcomeById(request.outcomeId)

  if (byOutcome && byOutcome.run_id !== request.runId) {
    return reject(
      'outcome_bound_to_other_run',
      `Outcome ${request.outcomeId} is already bound to Run ${byOutcome.run_id}.`
    )
  }
  if (byRun && byRun.outcome_id !== request.outcomeId) {
    // Why this is the core B2 guard: without it a new issue silently inherits
    // an unrelated historical Run and every later Task/Dispatch resolves there.
    return reject(
      'run_bound_to_other_outcome',
      `Run ${request.runId} is already bound to outcome ${byRun.outcome_id}.`
    )
  }
  if (byOutcome) {
    if (byOutcome.fingerprint !== request.fingerprint) {
      return reject(
        'fingerprint_conflict',
        `Outcome ${request.outcomeId} was admitted with a different fingerprint.`
      )
    }
    return { ok: true, outcome: byOutcome, duplicate: true }
  }

  store.insertOutcome({
    outcome_id: request.outcomeId,
    run_id: request.runId,
    title: request.title,
    fingerprint: request.fingerprint,
    intake_batch: request.intakeBatch ?? null,
    status: 'admitted',
    gate_policy: request.gatePolicy ?? 'standard'
  })
  const inserted = store.getOutcomeById(request.outcomeId)
  if (!inserted) {
    return reject('duplicate_outcome_id', `Outcome ${request.outcomeId} did not persist.`)
  }
  return { ok: true, outcome: inserted, duplicate: false }
}

export type OutcomeRelationDeclaration = {
  leftOutcomeId: string
  rightOutcomeId: string
  kind: OutcomeRelationRow['kind']
  decision: OutcomeRelationRow['decision']
  rationale: string
}

export type OutcomeIntakeRequest = {
  batchId: string
  /** Existence check for a claimed Run, supplied by the caller that owns the
   *  Run table. Omitted only by pure-function tests. */
  runExists?: (runId: string) => boolean
  outcomes: readonly OutcomeAdmissionRequest[]
  /** Every detected overlap or collision must carry an explicit decision. */
  relations?: readonly OutcomeRelationDeclaration[]
  /** Pairs the caller detected as overlapping or colliding. */
  detected?: readonly {
    leftOutcomeId: string
    rightOutcomeId: string
    kind: OutcomeRelationRow['kind']
  }[]
}

export type OutcomeIntakeResult =
  | { ok: true; admitted: OutcomeRow[] }
  | { ok: false; error: OutcomeAdmissionError }

function relationKey(left: string, right: string, kind: string): string {
  // Why sorted: overlap is symmetric, so (a,b) and (b,a) are the same decision.
  return [[left, right].sort().join('::'), kind].join('|')
}

/** Intake of 2–5 independent outcomes. Each is admitted to its own Run and
 *  stays independently addressable; an undetermined overlap or collision is a
 *  refusal, never an implicit merge. */
/** A stable fingerprint of everything the manifest asserts. Any change to the
 *  outcomes, the detected overlaps or the decisions is a different batch. */
export function intakeManifestFingerprint(request: OutcomeIntakeRequest): string {
  return outcomeFingerprint([
    ...request.outcomes
      .map((outcome) => `o:${outcome.outcomeId}:${outcome.runId}:${outcome.fingerprint}`)
      .sort(),
    ...(request.detected ?? [])
      .map((pair) => `d:${pair.leftOutcomeId}:${pair.rightOutcomeId}:${pair.kind}`)
      .sort(),
    ...(request.relations ?? [])
      .map(
        (relation) =>
          `r:${relation.leftOutcomeId}:${relation.rightOutcomeId}:${relation.kind}:${relation.decision}`
      )
      .sort()
  ])
}

export function admitOutcomeIntake(
  store: ControlPlaneStore,
  request: OutcomeIntakeRequest
): OutcomeIntakeResult {
  const first = request.outcomes[0]
  if (
    request.outcomes.length < MIN_OUTCOME_INTAKE ||
    request.outcomes.length > MAX_OUTCOME_INTAKE
  ) {
    return {
      ok: false,
      error: {
        code: 'intake_size_invalid',
        outcomeId: first?.outcomeId ?? '',
        runId: first?.runId ?? '',
        reason: `Intake must carry ${MIN_OUTCOME_INTAKE}–${MAX_OUTCOME_INTAKE} outcomes; received ${request.outcomes.length}.`
      }
    }
  }
  const runIds = new Set<string>()
  const ids = new Set<string>()
  for (const outcome of request.outcomes) {
    if (runIds.has(outcome.runId)) {
      return {
        ok: false,
        error: {
          code: 'duplicate_run_id',
          outcomeId: outcome.outcomeId,
          runId: outcome.runId,
          reason: `Run ${outcome.runId} appears twice in one intake batch; each outcome needs its own Run.`
        }
      }
    }
    runIds.add(outcome.runId)
    if (ids.has(outcome.outcomeId)) {
      return {
        ok: false,
        error: {
          code: 'duplicate_outcome_id',
          outcomeId: outcome.outcomeId,
          runId: outcome.runId,
          reason: `Outcome ${outcome.outcomeId} appears twice in one intake batch.`
        }
      }
    }
    ids.add(outcome.outcomeId)
    if (request.runExists && !request.runExists(outcome.runId)) {
      return {
        ok: false,
        error: {
          code: 'unknown_run',
          outcomeId: outcome.outcomeId,
          runId: outcome.runId,
          reason: `Run ${outcome.runId} does not exist, so an outcome cannot be bound to it.`
        }
      }
    }
  }
  const decided = new Set(
    (request.relations ?? []).map((relation) =>
      relationKey(relation.leftOutcomeId, relation.rightOutcomeId, relation.kind)
    )
  )
  for (const pair of request.detected ?? []) {
    if (!decided.has(relationKey(pair.leftOutcomeId, pair.rightOutcomeId, pair.kind))) {
      return {
        ok: false,
        error: {
          code: 'undecided_relation',
          outcomeId: pair.leftOutcomeId,
          runId: '',
          reason: `Detected ${pair.kind} between ${pair.leftOutcomeId} and ${pair.rightOutcomeId} has no explicit decision.`
        }
      }
    }
  }

  const deadlock = findSerializationDeadlock(store, request)
  if (deadlock) {
    return { ok: false, error: deadlock }
  }

  // Why a manifest fingerprint: `batchId` alone identified nothing, so the same
  // batch id could be replayed with a DIFFERENT outcome list and simply enlarge
  // the batch. The batch is what the manifest says it is.
  const fingerprint = intakeManifestFingerprint(request)
  const priorBatch = store.getIntakeBatch(request.batchId)
  if (priorBatch && priorBatch.manifest_fingerprint !== fingerprint) {
    return {
      ok: false,
      error: {
        code: 'batch_manifest_conflict',
        outcomeId: first?.outcomeId ?? '',
        runId: first?.runId ?? '',
        reason: `Batch ${request.batchId} was already admitted with a different manifest; a replay must be identical.`
      }
    }
  }

  // Why one transaction: admitting outcome 1 and failing on outcome 3 would
  // leave a half-admitted batch, and a caller that retried would then collide
  // with its own partial write. Intake is all-or-nothing.
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const admitted: OutcomeRow[] = []
    for (const outcome of request.outcomes) {
      const result = admitOutcome(store, { ...outcome, intakeBatch: request.batchId })
      if (!result.ok) {
        store.db.exec('ROLLBACK')
        return { ok: false, error: result.error }
      }
      admitted.push(result.outcome)
    }
    for (const relation of request.relations ?? []) {
      // Why compare first: the table replaces on (left, right, kind), so a
      // later batch could quietly flip `serialize` to `independent` and let two
      // colliding outcomes run together.
      const existing = store
        .listOutcomeRelations(relation.leftOutcomeId)
        .find(
          (row) => row.right_outcome_id === relation.rightOutcomeId && row.kind === relation.kind
        )
      if (existing && existing.decision !== relation.decision) {
        store.db.exec('ROLLBACK')
        return {
          ok: false,
          error: {
            code: 'relation_decision_conflict',
            outcomeId: relation.leftOutcomeId,
            runId: '',
            reason: `${relation.kind} between ${relation.leftOutcomeId} and ${relation.rightOutcomeId} is already decided ${existing.decision}; it cannot be changed to ${relation.decision} by a later intake.`
          }
        }
      }
      store.insertOutcomeRelation({
        left_outcome_id: relation.leftOutcomeId,
        right_outcome_id: relation.rightOutcomeId,
        kind: relation.kind,
        decision: relation.decision,
        rationale: relation.rationale
      })
    }
    store.putIntakeBatch({ batch_id: request.batchId, manifest_fingerprint: fingerprint })
    store.db.exec('COMMIT')
    return { ok: true, admitted }
  } catch (error) {
    // Why rollback then rethrow: an UNKNOWN mutation outcome must leave nothing
    // admitted, so the caller's retry starts from a clean batch.
    store.db.exec('ROLLBACK')
    throw error
  }
}

export type OutcomeBinding =
  | { kind: 'admitted'; outcome: OutcomeRow }
  /** A Run written before this package existed. Readable, but it can never
   *  satisfy a criterion that needs an outcome identity. */
  | { kind: 'legacy_unbound' }

export function resolveOutcomeBinding(store: ControlPlaneStore, runId: string): OutcomeBinding {
  const outcome = store.getOutcomeByRun(runId)
  return outcome ? { kind: 'admitted', outcome } : { kind: 'legacy_unbound' }
}

/** Fail-closed guard for a NEW write that claims an outcome identity. A legacy
 *  Run stays readable, but it cannot be claimed as an outcome after the fact. */
export function requireOutcomeMatch(
  store: ControlPlaneStore,
  args: { runId: string; outcomeId: string }
): { ok: true; outcome: OutcomeRow } | { ok: false; error: OutcomeAdmissionError } {
  const binding = resolveOutcomeBinding(store, args.runId)
  if (binding.kind === 'legacy_unbound') {
    return {
      ok: false,
      error: {
        code: 'run_bound_to_other_outcome',
        outcomeId: args.outcomeId,
        runId: args.runId,
        reason: `Run ${args.runId} has no admitted outcome; admit it before claiming ${args.outcomeId}.`
      }
    }
  }
  if (binding.outcome.outcome_id !== args.outcomeId) {
    return {
      ok: false,
      error: {
        code: 'run_bound_to_other_outcome',
        outcomeId: args.outcomeId,
        runId: args.runId,
        reason: `Run ${args.runId} is bound to outcome ${binding.outcome.outcome_id}, not ${args.outcomeId}.`
      }
    }
  }
  return { ok: true, outcome: binding.outcome }
}
