import type { ControlPlaneStore } from './control-plane-store'
import { MAX_OUTCOME_INTAKE, MIN_OUTCOME_INTAKE } from './outcome-identity'
import type {
  OutcomeIntakeRequest,
  OutcomeIntakeResult,
  OutcomeRelationDeclaration
} from './outcome-intake'
import {
  canonicalRelation,
  claimPairs,
  findDependencyCycle,
  relationKey
} from './outcome-intake-manifest'

/** Everything an intake batch must satisfy BEFORE anything is written.
 *
 *  Split out of `admitOutcomeIntake` so the all-or-nothing write transaction is
 *  readable on its own: every branch here returns a refusal and touches no
 *  state, so a failure leaves nothing half-admitted by construction.
 *
 *  Returns the refusal to report, or null when the batch may proceed. */
export function validateOutcomeIntake(
  store: ControlPlaneStore,
  request: OutcomeIntakeRequest
): Extract<OutcomeIntakeResult, { ok: false }> | null {
  void store
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
    if (!outcome.requiredGates || outcome.requiredGates.length === 0) {
      return {
        ok: false,
        error: {
          code: 'invalid_gate_spec',
          outcomeId: outcome.outcomeId,
          runId: outcome.runId,
          reason: `Outcome ${outcome.outcomeId} declares no runtime-owned required gate.`
        }
      }
    }
    if (
      !outcome.routingPolicy ||
      outcome.routingPolicy.builderCandidates.length === 0 ||
      outcome.routingPolicy.reviewerCandidates.length === 0
    ) {
      return {
        ok: false,
        error: {
          code: 'batch_manifest_conflict',
          outcomeId: outcome.outcomeId,
          runId: outcome.runId,
          reason: `Outcome ${outcome.outcomeId} must freeze non-empty builder and reviewer route orders.`
        }
      }
    }
    const gateIds = new Set<string>()
    const commandIdentities = new Set<string>()
    for (const gate of outcome.requiredGates ?? []) {
      if (
        !gate.gateId ||
        !gate.program ||
        !gate.policyVersion ||
        !gate.commandIdentity ||
        gate.dependencies.length === 0 ||
        gateIds.has(gate.gateId) ||
        commandIdentities.has(gate.commandIdentity)
      ) {
        return {
          ok: false,
          error: {
            code: 'invalid_gate_spec',
            outcomeId: outcome.outcomeId,
            runId: outcome.runId,
            reason: `Outcome ${outcome.outcomeId} has an incomplete, dependency-free, duplicate gate ID, or duplicate command identity at ${gate.gateId || '<unnamed>'}.`
          }
        }
      }
      gateIds.add(gate.gateId)
      commandIdentities.add(gate.commandIdentity)
    }
  }
  for (const outcome of request.outcomes) {
    for (const dependency of outcome.dependencies ?? []) {
      if (!ids.has(dependency)) {
        return {
          ok: false,
          error: {
            code: 'dependency_unknown',
            outcomeId: outcome.outcomeId,
            runId: outcome.runId,
            reason: `Outcome ${outcome.outcomeId} depends on ${dependency}, which is not a member of batch ${request.batchId}.`
          }
        }
      }
    }
  }
  const dependencyCycle = findDependencyCycle(request.outcomes)
  if (dependencyCycle) {
    return {
      ok: false,
      error: {
        code: 'dependency_cycle',
        outcomeId: dependencyCycle[0] ?? '',
        runId: '',
        reason: `Batch ${request.batchId} contains a dependency cycle: ${dependencyCycle.join(' -> ')}.`
      }
    }
  }

  const canonicalRelations = (request.relations ?? []).map(canonicalRelation)
  const relationDecisions = new Map<string, OutcomeRelationDeclaration>()
  for (const relation of canonicalRelations) {
    if (!ids.has(relation.leftOutcomeId) || !ids.has(relation.rightOutcomeId)) {
      return {
        ok: false,
        error: {
          code: 'relation_endpoint_unknown',
          outcomeId: relation.leftOutcomeId,
          runId: '',
          reason: `Relation ${relation.leftOutcomeId}/${relation.rightOutcomeId} must name two outcomes in batch ${request.batchId}.`
        }
      }
    }
    if (relation.leftOutcomeId === relation.rightOutcomeId) {
      return {
        ok: false,
        error: {
          code: 'relation_contradiction',
          outcomeId: relation.leftOutcomeId,
          runId: '',
          reason: `Outcome ${relation.leftOutcomeId} cannot declare a relationship with itself.`
        }
      }
    }
    const key = relationKey(relation.leftOutcomeId, relation.rightOutcomeId, relation.kind)
    const prior = relationDecisions.get(key)
    if (prior && (prior.decision !== relation.decision || prior.rationale !== relation.rationale)) {
      return {
        ok: false,
        error: {
          code: 'relation_contradiction',
          outcomeId: relation.leftOutcomeId,
          runId: '',
          reason: `Batch ${request.batchId} declares contradictory decisions for ${key}.`
        }
      }
    }
    relationDecisions.set(key, relation)
  }
  const decided = new Set(
    canonicalRelations.map((relation) =>
      relationKey(relation.leftOutcomeId, relation.rightOutcomeId, relation.kind)
    )
  )
  const detectedPairs = [...(request.detected ?? []), ...claimPairs(request)]
  for (const pair of detectedPairs) {
    if (!ids.has(pair.leftOutcomeId) || !ids.has(pair.rightOutcomeId)) {
      return {
        ok: false,
        error: {
          code: 'relation_endpoint_unknown',
          outcomeId: pair.leftOutcomeId,
          runId: '',
          reason: `Detected ${pair.kind} must name two outcomes in batch ${request.batchId}.`
        }
      }
    }
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
  return null
}
