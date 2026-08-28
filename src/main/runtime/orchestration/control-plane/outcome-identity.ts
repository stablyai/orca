import { createHash } from 'node:crypto'
import type { ControlPlaneStore, OutcomeRow } from './control-plane-store'
import type { RequiredGateDefinition } from './required-gate-spec'
import type { OutcomePolicy } from './outcome-policy'

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
  /** DCS/Sol-authored semantics frozen by the batch. Orca compares exact
   * claims and resources; it does not invent the business classification. */
  objective?: string
  target?: string
  dependencies?: readonly string[]
  semanticClaims?: readonly string[]
  resourceClaims?: readonly string[]
  /** DCS/Sol-authored role orders. Orca validates and follows them; it never
   * promotes one provider to a global default. */
  routingPolicy?: Omit<OutcomePolicy, 'outcomeId'>
  requiredGates?: readonly RequiredGateDefinition[]
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
  | 'relation_endpoint_unknown'
  | 'relation_contradiction'
  | 'dependency_unknown'
  | 'dependency_cycle'
  | 'invalid_gate_spec'
  | 'gate_spec_conflict'

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

export type OutcomeBinding =
  | { kind: 'admitted'; outcome: OutcomeRow }
  /** A Run written before this package existed. Readable, but it can never
   *  satisfy a criterion that needs an outcome identity. */
  | { kind: 'legacy_unbound' }

export function resolveOutcomeBinding(store: ControlPlaneStore, runId: string): OutcomeBinding {
  const outcome = store.getOutcomeByRun(runId)
  return outcome ? { kind: 'admitted', outcome } : { kind: 'legacy_unbound' }
}

/** Dependencies are read from the immutable admitted manifest, never from a
 * worker-start request. A malformed/missing manifest for a batch-admitted
 * outcome is fail-closed by returning null. */
export function readOutcomeDependencies(
  store: ControlPlaneStore,
  outcomeId: string
): readonly string[] | null {
  const outcome = store.getOutcomeById(outcomeId)
  if (!outcome?.intake_batch) {
    return []
  }
  const manifest = store.getIntakeManifest(outcome.intake_batch)
  if (!manifest) {
    return null
  }
  try {
    const parsed = JSON.parse(manifest.manifest_json) as {
      outcomes?: { outcomeId?: unknown; dependencies?: unknown }[]
    }
    const entry = parsed.outcomes?.find((candidate) => candidate.outcomeId === outcomeId)
    return entry && Array.isArray(entry.dependencies) && entry.dependencies.every(isString)
      ? entry.dependencies
      : null
  } catch {
    return null
  }
}

/** The exact managed worktree frozen by intake. A batch-admitted outcome may
 * never be started in a caller-selected sibling tree. */
export function readOutcomeTarget(store: ControlPlaneStore, outcomeId: string): string | null {
  const outcome = store.getOutcomeById(outcomeId)
  if (!outcome?.intake_batch) {
    return null
  }
  const manifest = store.getIntakeManifest(outcome.intake_batch)
  if (!manifest) {
    return null
  }
  try {
    const parsed = JSON.parse(manifest.manifest_json) as {
      outcomes?: { outcomeId?: unknown; target?: unknown }[]
    }
    const entry = parsed.outcomes?.find((candidate) => candidate.outcomeId === outcomeId)
    return entry && typeof entry.target === 'string' ? entry.target : null
  } catch {
    return null
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
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
