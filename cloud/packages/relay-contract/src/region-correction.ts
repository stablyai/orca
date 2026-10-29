import { z } from 'zod'
import { EpochMsSchema, GenerationSchema } from './wire-scalars.js'
import { RelayRegionSchema } from './relay-regions.js'

const RttSchema = z.number().finite().nonnegative().max(120_000)
export const RegionMeasurementsSchema = z
  .object({
    'us-central1': RttSchema,
    'asia-east2': RttSchema
  })
  .strict()

export const RegionMeasurementWindowSchema = z
  .object({
    generation: GenerationSchema,
    expiresAt: EpochMsSchema,
    assignmentEpoch: GenerationSchema,
    incumbentRegion: RelayRegionSchema,
    policyVersion: z.literal(1)
  })
  .strict()

const ReportBasis = {
  v: z.literal(1),
  action: z.literal('report'),
  generation: GenerationSchema,
  assignmentEpoch: GenerationSchema,
  policyVersion: z.literal(1)
}

export const RegionCorrectionRequestSchema = z.union([
  z.object({ v: z.literal(1), action: z.literal('issue-window') }).strict(),
  z
    .object({
      ...ReportBasis,
      outcome: z.literal('conclusive'),
      measurements: RegionMeasurementsSchema
    })
    .strict(),
  z
    .object({
      ...ReportBasis,
      outcome: z.literal('inconclusive'),
      reason: z.string().min(1).max(64)
    })
    .strict()
])

export const RegionCorrectionResponseSchema = z
  .object({
    v: z.literal(1),
    window: RegionMeasurementWindowSchema.optional(),
    reportStatus: z.enum(['accepted', 'duplicate', 'stale', 'expired', 'basis-changed']).optional()
  })
  .strict()

export type RegionMeasurements = z.infer<typeof RegionMeasurementsSchema>
export type RegionMeasurementWindow = z.infer<typeof RegionMeasurementWindowSchema>
export type RegionCorrectionRequest = z.infer<typeof RegionCorrectionRequestSchema>
export type RegionCorrectionResponse = z.infer<typeof RegionCorrectionResponseSchema>
