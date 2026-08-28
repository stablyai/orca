import { createHash } from 'node:crypto'
import type { OutcomeAdmissionRequest } from './outcome-identity'
import type { OutcomeIntakeRequest, OutcomeRelationDeclaration } from './outcome-intake'
import type { OutcomeRelationRow } from './control-plane-store'

/** How an intake batch is canonicalised and fingerprinted.
 *
 *  Kept beside the intake it serves rather than inside it: the manifest is what
 *  decides whether a replayed batch id is the SAME batch, so its normalisation
 *  has to be readable on its own.
 */

export function relationKey(left: string, right: string, kind: string): string {
  // Why sorted: overlap is symmetric, so (a,b) and (b,a) are the same decision.
  return [[left, right].sort().join('::'), kind].join('|')
}

export function canonicalEndpoints(left: string, right: string): [string, string] {
  return left <= right ? [left, right] : [right, left]
}

export function canonicalRelation(
  relation: OutcomeRelationDeclaration
): OutcomeRelationDeclaration {
  const [leftOutcomeId, rightOutcomeId] = canonicalEndpoints(
    relation.leftOutcomeId,
    relation.rightOutcomeId
  )
  return { ...relation, leftOutcomeId, rightOutcomeId }
}

/** Intake of 2–5 independent outcomes. Each is admitted to its own Run and
 *  stays independently addressable; an undetermined overlap or collision is a
 *  refusal, never an implicit merge. */
/** A stable fingerprint of everything the manifest asserts. Any change to the
 *  outcomes, the detected overlaps or the decisions is a different batch. */
export function intakeManifestFingerprint(request: OutcomeIntakeRequest): string {
  return createHash('sha256').update(normalizedIntakeManifest(request)).digest('hex')
}

/** Complete canonical admission payload. A same-key replay is identical only
 * when every operationally material assertion is identical. */
export function normalizedIntakeManifest(request: OutcomeIntakeRequest): string {
  const sorted = (values: readonly string[] | undefined) => [...new Set(values ?? [])].sort()
  return JSON.stringify({
    schemaVersion: request.manifestSchemaVersion ?? 1,
    outcomes: request.outcomes
      .map((outcome) => ({
        outcomeId: outcome.outcomeId,
        runId: outcome.runId,
        title: outcome.title,
        fingerprint: outcome.fingerprint,
        gatePolicy: outcome.gatePolicy ?? 'standard',
        objective: outcome.objective ?? '',
        target: outcome.target ?? '',
        dependencies: sorted(outcome.dependencies),
        semanticClaims: sorted(outcome.semanticClaims),
        resourceClaims: sorted(outcome.resourceClaims),
        routingPolicy: outcome.routingPolicy
          ? {
              taskClassification: outcome.routingPolicy.taskClassification,
              builderCandidates: outcome.routingPolicy.builderCandidates,
              reviewerCandidates: outcome.routingPolicy.reviewerCandidates,
              reviewCapabilities: sorted(outcome.routingPolicy.reviewCapabilities),
              allowUnknownQuota: outcome.routingPolicy.allowUnknownQuota
            }
          : null,
        requiredGates: [...(outcome.requiredGates ?? [])]
          .map((gate) => ({
            ...gate,
            args: [...gate.args],
            dependencies: sorted(gate.dependencies)
          }))
          .sort((left, right) => left.gateId.localeCompare(right.gateId))
      }))
      .sort((left, right) => left.outcomeId.localeCompare(right.outcomeId)),
    detected: [...(request.detected ?? [])]
      .map((pair) => {
        const [leftOutcomeId, rightOutcomeId] = canonicalEndpoints(
          pair.leftOutcomeId,
          pair.rightOutcomeId
        )
        return { ...pair, leftOutcomeId, rightOutcomeId }
      })
      .sort((left, right) =>
        relationKey(left.leftOutcomeId, left.rightOutcomeId, left.kind).localeCompare(
          relationKey(right.leftOutcomeId, right.rightOutcomeId, right.kind)
        )
      ),
    relations: [...(request.relations ?? [])]
      .map(canonicalRelation)
      .sort((left, right) =>
        relationKey(left.leftOutcomeId, left.rightOutcomeId, left.kind).localeCompare(
          relationKey(right.leftOutcomeId, right.rightOutcomeId, right.kind)
        )
      )
  })
}

export function claimPairs(request: OutcomeIntakeRequest): {
  leftOutcomeId: string
  rightOutcomeId: string
  kind: OutcomeRelationRow['kind']
}[] {
  const pairs: {
    leftOutcomeId: string
    rightOutcomeId: string
    kind: OutcomeRelationRow['kind']
  }[] = []
  for (let leftIndex = 0; leftIndex < request.outcomes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < request.outcomes.length; rightIndex += 1) {
      const left = request.outcomes[leftIndex]
      const right = request.outcomes[rightIndex]
      if (!left || !right) {
        continue
      }
      if (
        (left.semanticClaims ?? []).some((claim) => (right.semanticClaims ?? []).includes(claim))
      ) {
        pairs.push({
          leftOutcomeId: left.outcomeId,
          rightOutcomeId: right.outcomeId,
          kind: 'semantic_overlap'
        })
      }
      if (
        (left.resourceClaims ?? []).some((claim) => (right.resourceClaims ?? []).includes(claim))
      ) {
        pairs.push({
          leftOutcomeId: left.outcomeId,
          rightOutcomeId: right.outcomeId,
          kind: 'resource_collision'
        })
      }
    }
  }
  return pairs
}

export function findDependencyCycle(outcomes: readonly OutcomeAdmissionRequest[]): string[] | null {
  const graph = new Map(outcomes.map((outcome) => [outcome.outcomeId, outcome.dependencies ?? []]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      return [...path.slice(path.indexOf(id)), id]
    }
    if (visited.has(id)) {
      return null
    }
    visiting.add(id)
    path.push(id)
    for (const dependency of graph.get(id) ?? []) {
      const cycle = visit(dependency)
      if (cycle) {
        return cycle
      }
    }
    path.pop()
    visiting.delete(id)
    visited.add(id)
    return null
  }
  for (const id of graph.keys()) {
    const cycle = visit(id)
    if (cycle) {
      return cycle
    }
  }
  return null
}
