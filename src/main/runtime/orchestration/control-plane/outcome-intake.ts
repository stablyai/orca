import type { ControlPlaneStore, OutcomeRelationRow, OutcomeRow } from './control-plane-store'
import { findSerializationDeadlock } from './outcome-relation-deadlock'
import { requiredGateSpecRow } from './required-gate-spec'
import { OutcomePolicyStore } from './outcome-policy'

import {
  admitOutcome,
  type OutcomeAdmissionError,
  type OutcomeAdmissionRequest
} from './outcome-identity'

import {
  intakeManifestFingerprint,
  normalizedIntakeManifest,
  canonicalRelation
} from './outcome-intake-manifest'
import { validateOutcomeIntake } from './outcome-intake-validation'

export { intakeManifestFingerprint, normalizedIntakeManifest } from './outcome-intake-manifest'

/** The 2–5 outcome intake half of outcome identity.
 *
 *  Extracted verbatim so the admission primitives and the batch intake can each
 *  stay readable; the manifest fingerprint, relation canonicalisation and cycle
 *  detection all belong to intake and nothing else uses them.
 */

export type OutcomeRelationDeclaration = {
  leftOutcomeId: string
  rightOutcomeId: string
  kind: OutcomeRelationRow['kind']
  decision: OutcomeRelationRow['decision']
  rationale: string
}

export type OutcomeIntakeRequest = {
  batchId: string
  manifestSchemaVersion?: number
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

export function admitOutcomeIntake(
  store: ControlPlaneStore,
  request: OutcomeIntakeRequest
): OutcomeIntakeResult {
  const refusal = validateOutcomeIntake(store, request)
  if (refusal) {
    return refusal
  }
  // Recomputed here rather than threaded out of validation: both are cheap pure
  // derivations, and passing them back would make the validator's return value
  // carry state as well as a verdict.
  const canonicalRelations = (request.relations ?? []).map(canonicalRelation)
  const first = request.outcomes[0]
  // Why a manifest fingerprint: `batchId` alone identified nothing, so the same
  // batch id could be replayed with a DIFFERENT outcome list and simply enlarge
  // the batch. The batch is what the manifest says it is.
  const manifest = normalizedIntakeManifest(request)
  const fingerprint = intakeManifestFingerprint(request)

  // Why one transaction: admitting outcome 1 and failing on outcome 3 would
  // leave a half-admitted batch, and a caller that retried would then collide
  // with its own partial write. Intake is all-or-nothing.
  store.db.exec('BEGIN IMMEDIATE')
  try {
    const lockedRequest = { ...request, relations: canonicalRelations }
    const deadlock = findSerializationDeadlock(store, lockedRequest)
    if (deadlock) {
      store.db.exec('ROLLBACK')
      return { ok: false, error: deadlock }
    }
    // Re-read only AFTER the write lock. Two concurrent requests can both see
    // an absent key before BEGIN IMMEDIATE; the second must compare the row the
    // first committed while it waited, not proceed on its stale pre-lock read.
    const priorBatch = store.getIntakeBatch(request.batchId)
    const priorManifest = store.getIntakeManifest(request.batchId)
    if (
      priorBatch &&
      (priorBatch.manifest_fingerprint !== fingerprint ||
        priorManifest?.manifest_json !== manifest ||
        priorManifest.schema_version !== (request.manifestSchemaVersion ?? 1))
    ) {
      store.db.exec('ROLLBACK')
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
    if (priorBatch && !priorManifest) {
      store.db.exec('ROLLBACK')
      return {
        ok: false,
        error: {
          code: 'batch_manifest_conflict',
          outcomeId: first?.outcomeId ?? '',
          runId: first?.runId ?? '',
          reason: `Batch ${request.batchId} predates the complete manifest ledger and cannot be enlarged or replayed as a schema-v1 batch.`
        }
      }
    }
    const admitted: OutcomeRow[] = []
    for (const outcome of request.outcomes) {
      const existingOutcome = store.getOutcomeById(outcome.outcomeId)
      const existingRunOutcome = store.getOutcomeByRun(outcome.runId)
      if (
        (existingOutcome && existingOutcome.intake_batch !== request.batchId) ||
        (existingRunOutcome && existingRunOutcome.intake_batch !== request.batchId)
      ) {
        store.db.exec('ROLLBACK')
        return {
          ok: false,
          error: {
            code: 'batch_manifest_conflict',
            outcomeId: outcome.outcomeId,
            runId: outcome.runId,
            reason: `Outcome ${outcome.outcomeId} or Run ${outcome.runId} was admitted by another batch and cannot be enriched or rebound.`
          }
        }
      }
      const result = admitOutcome(store, { ...outcome, intakeBatch: request.batchId })
      if (!result.ok) {
        store.db.exec('ROLLBACK')
        return { ok: false, error: result.error }
      }
      admitted.push(result.outcome)
      for (const gate of outcome.requiredGates ?? []) {
        const existing = store.getRequiredGateSpec(outcome.outcomeId, gate.gateId)
        const next = requiredGateSpecRow(outcome.outcomeId, gate)
        if (existing && existing.spec_hash !== next.spec_hash) {
          store.db.exec('ROLLBACK')
          return {
            ok: false,
            error: {
              code: 'gate_spec_conflict',
              outcomeId: outcome.outcomeId,
              runId: outcome.runId,
              reason: `Required gate ${gate.gateId} for ${outcome.outcomeId} is immutable after admission.`
            }
          }
        }
        if (!existing) {
          store.insertRequiredGateSpec(next)
        }
      }
      const routingPolicy = outcome.routingPolicy
      if (!routingPolicy) {
        throw new Error(`Outcome ${outcome.outcomeId} lost its validated routing policy.`)
      }
      new OutcomePolicyStore(store).put({ outcomeId: outcome.outcomeId, ...routingPolicy })
    }
    for (const relation of canonicalRelations) {
      // Why compare first: the table replaces on (left, right, kind), so a
      // later batch could quietly flip `serialize` to `independent` and let two
      // colliding outcomes run together.
      const existing = store
        .listOutcomeRelations(relation.leftOutcomeId)
        .find(
          (row) => row.right_outcome_id === relation.rightOutcomeId && row.kind === relation.kind
        )
      if (
        existing &&
        (existing.decision !== relation.decision || existing.rationale !== relation.rationale)
      ) {
        store.db.exec('ROLLBACK')
        return {
          ok: false,
          error: {
            code: 'relation_decision_conflict',
            outcomeId: relation.leftOutcomeId,
            runId: '',
            reason: `${relation.kind} between ${relation.leftOutcomeId} and ${relation.rightOutcomeId} is immutable after admission.`
          }
        }
      }
      if (!existing) {
        store.insertOutcomeRelation({
          left_outcome_id: relation.leftOutcomeId,
          right_outcome_id: relation.rightOutcomeId,
          kind: relation.kind,
          decision: relation.decision,
          rationale: relation.rationale
        })
      }
    }
    if (!priorBatch) {
      store.putIntakeBatch({ batch_id: request.batchId, manifest_fingerprint: fingerprint })
      store.putIntakeManifest({
        batch_id: request.batchId,
        schema_version: request.manifestSchemaVersion ?? 1,
        manifest_json: manifest
      })
    }
    store.db.exec('COMMIT')
    return { ok: true, admitted }
  } catch (error) {
    // Why rollback then rethrow: an UNKNOWN mutation outcome must leave nothing
    // admitted, so the caller's retry starts from a clean batch.
    store.db.exec('ROLLBACK')
    throw error
  }
}
