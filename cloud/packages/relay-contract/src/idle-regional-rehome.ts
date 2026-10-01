import { z } from 'zod'
import { GenerationSchema, RelayHostIdSchema } from './wire-scalars.js'

export const IdleRegionalRehomeRequestSchema = z
  .object({
    v: z.literal(1),
    attemptId: z.string().uuid(),
    userId: z.string().min(1).max(256),
    relayHostId: RelayHostIdSchema,
    sourceCellId: z.string().min(1).max(128),
    sourceCellIncarnation: z.string().uuid(),
    sourceAssignmentEpoch: GenerationSchema.refine((value) => value > 0),
    sourceGeneration: GenerationSchema.refine((value) => value > 0),
    targetCellId: z.string().min(1).max(128)
  })
  .strict()

// Deferrals no other candidate in the same poll can get past: the source
// re-reads the same durable row for every request, so the next POST takes the
// same branch. The director stops walking its list on one of these.
export const GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS = [
  'control-closed',
  'budget-closed',
  'concurrency-limit',
  'cohort-closed',
  'fleet-safety'
] as const

export const IDLE_REGIONAL_REHOME_DEFER_REASONS = [
  ...GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS,
  'candidate-ineligible',
  'host-unsupported',
  'director-safety-stale'
] as const

export const IdleRegionalRehomeResponseSchema = z
  .object({
    v: z.literal(1),
    outcome: z.enum(['busy', 'committed', 'deferred', 'stale']),
    // Optional both ways: a source cell on an older image omits it and the
    // director keeps its walk-the-whole-list behaviour, and a reason a newer
    // cell adds later reads as absent instead of failing the whole response.
    reason: z.enum(IDLE_REGIONAL_REHOME_DEFER_REASONS).optional().catch(undefined)
  })
  // Unknown keys are dropped rather than rejected, so the next optional field
  // on this response does not have to wait for every director to redeploy.
  .strip()

export type IdleRegionalRehomeRequest = z.infer<typeof IdleRegionalRehomeRequestSchema>
export type IdleRegionalRehomeOutcome = z.infer<typeof IdleRegionalRehomeResponseSchema>['outcome']
export type IdleRegionalRehomeDeferReason = (typeof IDLE_REGIONAL_REHOME_DEFER_REASONS)[number]

// What the source cell answers: `busy` and `stale` come from the host session,
// the rest from the durable commit, and `reason` is set only for a deferral.
export type IdleRegionalRehomeResult = {
  outcome: IdleRegionalRehomeOutcome
  reason?: IdleRegionalRehomeDeferReason
}

export type IdleRegionalRehomeCommit = {
  outcome: Exclude<IdleRegionalRehomeOutcome, 'busy'>
  reason?: IdleRegionalRehomeDeferReason
}

export type GlobalIdleRegionalRehomeDeferReason =
  (typeof GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS)[number]

export function isGlobalIdleRegionalRehomeDeferral(
  reason: IdleRegionalRehomeDeferReason | undefined
): reason is GlobalIdleRegionalRehomeDeferReason {
  return GLOBAL_IDLE_REGIONAL_REHOME_DEFER_REASONS.some((global) => global === reason)
}
