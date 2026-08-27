import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { admitOutcomeIntake } from '../../orchestration/control-plane/outcome-identity'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

/** Sol/DCS hand Orca 2-5 outcome manifests plus their own semantic claims.
 *  Orca binds identity and decides overlap; it never classifies the business
 *  issue itself, so the claims arrive already made. */
const OutcomeIntakeParams = z.object({
  from: OptionalString,
  batchId: requiredString('Missing --batch-id'),
  outcomes: z
    .array(
      z.object({
        outcomeId: requiredString('Missing outcomeId'),
        runId: requiredString('Missing runId'),
        title: requiredString('Missing title'),
        fingerprint: requiredString('Missing fingerprint')
      })
    )
    .min(1),
  /** Overlaps the SUPPLIER detected, which must each carry a decision. */
  detected: z
    .array(
      z.object({
        leftOutcomeId: requiredString('Missing leftOutcomeId'),
        rightOutcomeId: requiredString('Missing rightOutcomeId'),
        kind: z.enum(['semantic_overlap', 'resource_collision'])
      })
    )
    .optional(),
  relations: z
    .array(
      z.object({
        leftOutcomeId: requiredString('Missing leftOutcomeId'),
        rightOutcomeId: requiredString('Missing rightOutcomeId'),
        kind: z.enum(['semantic_overlap', 'resource_collision']),
        // `reject` is a decision the caller may return, and it refuses the whole
        // batch rather than being stored as an admitted relation.
        decision: z.enum(['independent', 'serialize', 'merge', 'reject']),
        rationale: requiredString('Missing rationale')
      })
    )
    .optional()
})

export const ORCHESTRATION_OUTCOME_INTAKE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.outcomeIntake',
    params: OutcomeIntakeParams,
    handler: (params, { runtime }) => {
      const store = new ControlPlaneStore(runtime.getOrchestrationDb())
      const rejected = (params.relations ?? []).find((relation) => relation.decision === 'reject')
      if (rejected) {
        throw new OrchestrationError(
          'outcome_intake_rejected',
          `Overlap ${rejected.kind} between ${rejected.leftOutcomeId} and ${rejected.rightOutcomeId} was decided 'reject': ${rejected.rationale}`,
          { code: 'relation_rejected', outcomeId: rejected.leftOutcomeId, runId: '' }
        )
      }
      const db = runtime.getOrchestrationDb()
      const result = admitOutcomeIntake(store, {
        batchId: params.batchId,
        // Why: an outcome bound to a Run that does not exist is unreachable.
        runExists: (runId) => Boolean(db.getRun(runId)),
        outcomes: params.outcomes,
        detected: params.detected,
        relations: (params.relations ?? []).filter(
          (relation) => relation.decision !== 'reject'
        ) as {
          leftOutcomeId: string
          rightOutcomeId: string
          kind: 'semantic_overlap' | 'resource_collision'
          decision: 'independent' | 'serialize' | 'merge'
          rationale: string
        }[]
      })
      if (!result.ok) {
        // Why one typed error rather than a partial receipt: the whole batch
        // either binds or nothing does, and the caller must see which outcome
        // stopped it.
        throw new OrchestrationError('outcome_intake_rejected', result.error.reason, {
          code: result.error.code,
          outcomeId: result.error.outcomeId,
          runId: result.error.runId
        })
      }
      return {
        batchId: params.batchId,
        admitted: result.admitted.map((outcome) => ({
          outcomeId: outcome.outcome_id,
          runId: outcome.run_id,
          title: outcome.title,
          status: outcome.status
        })),
        relations: (params.relations ?? []).map((relation) => ({
          left: relation.leftOutcomeId,
          right: relation.rightOutcomeId,
          kind: relation.kind,
          decision: relation.decision
        })),
        count: result.admitted.length
      }
    }
  })
]
