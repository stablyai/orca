import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { resolveRunScope } from './orchestration-run-scope'

// MoA (Mixture of Agents) deliberation ledger methods. The ledger rows are
// append-only and content-addressed (see db/moa-ledger/moa-ledger-store.ts);
// entry kinds and verdicts are validated by the store, keeping one source of
// truth for the strict write path and the transport-tolerant payload.moa
// materializer.

const MoaEntrySchema = z.object({
  round: z.number().int().optional(),
  kind: z.string(),
  seat: z.string().optional(),
  subjectEntryId: z.string().optional(),
  verdict: z.string().optional(),
  rationale: z.string().optional(),
  payload: z.string().optional(),
  authoredAt: z.string().optional()
})

const MoaLogParams = z.object({
  deliberation: requiredString('Missing --deliberation'),
  task: OptionalString,
  seatCount: OptionalFiniteNumber,
  entries: z.array(MoaEntrySchema).min(1, 'At least one entry is required'),
  from: OptionalString,
  run: OptionalString
})

const MoaShowParams = z.object({
  deliberation: OptionalString,
  round: OptionalFiniteNumber,
  from: OptionalString,
  run: OptionalString
})

export const ORCHESTRATION_MOA_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.moaLog',
    params: MoaLogParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const result = db.logMoaEntries({
        runId: run.id,
        deliberationId: params.deliberation,
        taskId: params.task,
        seatCount: params.seatCount,
        entries: params.entries
      })
      return {
        deliberation: result.deliberation,
        inserted: result.inserted,
        duplicates: result.duplicates
      }
    }
  }),

  defineMethod({
    name: 'orchestration.moaShow',
    params: MoaShowParams,
    handler: (params, { orchestrationCompatibilityEvidence, runtime, legacyCoordinatorRunId }) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      // Why: same read posture as gateList — an explicitly named Run is inspectable, an unnamed one means the caller's own.
      const run =
        explicitRun?.legacy === 1
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.from,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence
            })
      if (params.deliberation) {
        const deliberation = db.getMoaDeliberation(params.deliberation)
        // Why: a deliberation outside the caller's Run is indistinguishable from a missing one, so probing cannot map foreign Runs.
        if (!deliberation || deliberation.run_id !== run.id) {
          throw new Error(`MoA deliberation not found: ${params.deliberation}`)
        }
        const entries = db.listMoaEntries({
          deliberationId: deliberation.id,
          round: params.round
        })
        return { runId: run.id, deliberation, entries, count: entries.length }
      }
      const deliberations = db.listMoaDeliberations({ runId: run.id })
      return { runId: run.id, deliberations, count: deliberations.length }
    }
  })
]
