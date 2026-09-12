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

export const IdleRegionalRehomeResponseSchema = z
  .object({
    v: z.literal(1),
    outcome: z.enum(['busy', 'committed', 'deferred', 'stale'])
  })
  .strict()

export type IdleRegionalRehomeRequest = z.infer<typeof IdleRegionalRehomeRequestSchema>
export type IdleRegionalRehomeOutcome = z.infer<typeof IdleRegionalRehomeResponseSchema>['outcome']
