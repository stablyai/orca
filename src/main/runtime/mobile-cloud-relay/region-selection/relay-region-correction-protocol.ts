import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { RelayRegionSchema } from './relay-region-probe'

const Counter = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
export const RelayRegionWindowSchema = lazyZodSchema(() =>
  z
    .object({
      generation: Counter,
      expiresAt: Counter,
      assignmentEpoch: Counter,
      incumbentRegion: RelayRegionSchema,
      policyVersion: z.literal(1)
    })
    .strict()
)

export const RelayRegionCorrectionResponseSchema = lazyZodSchema(() =>
  z
    .object({
      v: z.literal(1),
      window: RelayRegionWindowSchema.optional(),
      reportStatus: z
        .enum(['accepted', 'duplicate', 'stale', 'expired', 'basis-changed'])
        .optional()
    })
    .strict()
)

export type RelayRegionWindow = z.infer<typeof RelayRegionWindowSchema>
export type RelayRegionDecision =
  | { outcome: 'conclusive'; measurements: Record<z.infer<typeof RelayRegionSchema>, number> }
  | {
      outcome: 'inconclusive'
      reason:
        | 'diagnostic-override'
        | 'catalog-unavailable'
        | 'incomplete-measurement'
        | 'insufficient-improvement'
        | 'expired-window'
    }
export type RelayRegionCorrectionRequest =
  | { v: 1; action: 'issue-window' }
  | ({
      v: 1
      action: 'report'
      generation: number
      assignmentEpoch: number
      policyVersion: 1
    } & RelayRegionDecision)
