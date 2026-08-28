import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { admitOutcomeIntake } from '../../orchestration/control-plane/outcome-intake'
import {
  exactGateAssertion,
  readRequiredGateCatalog
} from '../../orchestration/control-plane/required-gate-catalog'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { resolveOrchestrationCaller } from './orchestration-run-scope'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

const RouteIdentitySchema = z.object({
  agent: requiredString('Missing route agent').refine(isTuiAgent, 'Unknown route agent'),
  model: z.string().nullable(),
  reasoning: z.string().nullable()
})

/** Sol/DCS hand Orca 2-5 outcome manifests plus their own semantic claims.
 *  Orca binds identity and decides overlap; it never classifies the business
 *  issue itself, so the claims arrive already made. */
const OutcomeIntakeParams = z.object({
  from: requiredString('Missing coordinator terminal'),
  batchId: requiredString('Missing --batch-id'),
  schemaVersion: z.number().int().positive().optional(),
  outcomes: z.array(
    z.object({
      outcomeId: requiredString('Missing outcomeId'),
      runId: requiredString('Missing runId'),
      title: requiredString('Missing title'),
      fingerprint: requiredString('Missing fingerprint'),
      objective: requiredString('Missing objective'),
      target: requiredString('Missing target'),
      dependencies: z.array(requiredString('Invalid dependency')),
      semanticClaims: z.array(requiredString('Invalid semantic claim')),
      resourceClaims: z.array(requiredString('Invalid resource claim')),
      routingPolicy: z.object({
        taskClassification: requiredString('Missing task classification'),
        builderCandidates: z.array(RouteIdentitySchema).min(1),
        reviewerCandidates: z.array(RouteIdentitySchema).min(1),
        reviewCapabilities: z.array(requiredString('Invalid review capability')),
        allowUnknownQuota: z.boolean()
      }),
      gatePolicy: z.enum(['standard', 'high_risk']).optional(),
      requiredGates: z
        .array(
          z.object({
            gateId: requiredString('Missing gateId'),
            program: requiredString('Missing gate program'),
            args: z.array(z.string()),
            dependencies: z.array(requiredString('Invalid gate dependency')).min(1),
            policyVersion: requiredString('Missing gate policy version'),
            commandIdentity: requiredString('Missing gate command identity'),
            shaBinding: z.enum(['content', 'exact_head'])
          })
        )
        .min(1)
    })
  ),
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
    handler: async (
      params,
      {
        runtime,
        orchestrationCompatibilityEvidence,
        orchestrationCompatibilityCallerAuthority: callerAuthority
      }
    ) => {
      const callerPane = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerAuthority,
        requireStablePane: true
      })
      if (
        callerAuthority?.terminalHandle !== params.from ||
        callerAuthority.paneKey !== callerPane
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          'Outcome intake requires attested authority from the coordinator terminal that owns every submitted Run.',
          { effectsApplied: false }
        )
      }
      const store = new ControlPlaneStore(runtime.getOrchestrationDb())
      const rejected = (params.relations ?? []).find((relation) => relation.decision === 'reject')
      if (rejected) {
        throw new OrchestrationError(
          'outcome_intake_rejected',
          `Overlap ${rejected.kind} between ${rejected.leftOutcomeId} and ${rejected.rightOutcomeId} was decided 'reject': ${rejected.rationale}`,
          { code: 'relation_rejected', outcomeId: rejected.leftOutcomeId, runId: '' }
        )
      }
      const merged = (params.relations ?? []).find((relation) => relation.decision === 'merge')
      if (merged) {
        throw new OrchestrationError(
          'outcome_intake_rejected',
          `Outcomes ${merged.leftOutcomeId} and ${merged.rightOutcomeId} were declared one merged outcome. Submit one canonical outcome/Run instead of admitting two independently startable Runs.`,
          { code: 'merged_outcome_requires_rebatch', outcomeId: merged.leftOutcomeId, runId: '' }
        )
      }
      const db = runtime.getOrchestrationDb()
      const callerOwnedRunIds = new Set(db.getRunMailboxOwnerIdsForHandle(params.from))
      const foreignRun = params.outcomes.find((outcome) => {
        const run = db.getRun(outcome.runId)
        // One pane can be CURRENT on only one Run, but a 2–5 intake necessarily
        // spans several Runs. Durable run_coordinator_handles is the ownership
        // ledger; the live caller authority above proves who is invoking it.
        return !run || run.legacy === 1 || !callerOwnedRunIds.has(run.id)
      })
      if (foreignRun) {
        throw new OrchestrationError(
          'consumer_fenced',
          `Outcome ${foreignRun.outcomeId} names Run ${foreignRun.runId}, which is not owned by the attested batch coordinator.`,
          { effectsApplied: false }
        )
      }
      const canonicalOutcomes: typeof params.outcomes = []
      for (const outcome of params.outcomes) {
        let worktree
        try {
          worktree = await runtime.showManagedTerminalWorkspace(outcome.target)
        } catch (error) {
          throw new OrchestrationError(
            'required_gate_catalog_unavailable',
            `Outcome ${outcome.outcomeId} target ${outcome.target} is not a runtime-managed worktree: ${String(error)}`,
            { effectsApplied: false }
          )
        }
        if (!worktree.path) {
          throw new OrchestrationError(
            'required_gate_catalog_unavailable',
            `Outcome ${outcome.outcomeId} target ${outcome.target} has no local repository path from which gate authority can be read.`,
            { effectsApplied: false }
          )
        }
        let catalog
        try {
          catalog = readRequiredGateCatalog(worktree.path)
        } catch (error) {
          throw new OrchestrationError(
            'required_gate_catalog_unavailable',
            `Outcome ${outcome.outcomeId} has no clean committed gate catalog: ${String(error)}`,
            { effectsApplied: false }
          )
        }
        let requiredGates
        try {
          requiredGates = outcome.requiredGates.map((gate) => exactGateAssertion(gate, catalog))
        } catch (error) {
          throw new OrchestrationError(
            'required_gate_substitution',
            `Outcome ${outcome.outcomeId} tried to redefine a repository-owned required gate: ${String(error)}`,
            { effectsApplied: false }
          )
        }
        canonicalOutcomes.push({
          ...outcome,
          target: `id:${worktree.id}`,
          requiredGates
        })
      }
      const result = admitOutcomeIntake(store, {
        batchId: params.batchId,
        manifestSchemaVersion: params.schemaVersion ?? 1,
        // Why: an outcome bound to a Run that does not exist is unreachable.
        runExists: (runId) => Boolean(db.getRun(runId)),
        outcomes: canonicalOutcomes,
        detected: params.detected,
        relations: (params.relations ?? []).filter(
          (relation) => relation.decision !== 'reject'
        ) as {
          leftOutcomeId: string
          rightOutcomeId: string
          kind: 'semantic_overlap' | 'resource_collision'
          decision: 'independent' | 'serialize'
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
