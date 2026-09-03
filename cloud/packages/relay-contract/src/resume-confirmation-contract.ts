import { z } from 'zod'
import { EpochMsSchema, GenerationSchema, OpaqueIdSchema } from './wire-scalars.js'

export const ConfirmableResumeTupleSchema = z
  .object({
    basisConnId: OpaqueIdSchema,
    owningControlGeneration: GenerationSchema,
    relayDeviceId: OpaqueIdSchema,
    acceptedCredentialVersion: z.number().int().positive(),
    acceptedAs: z.enum(['current', 'grace']),
    confirmDeadline: EpochMsSchema
  })
  .strict()

export const RESUME_CONFIRMATION_COMMIT_OUTCOME = {
  RENEW_CURRENT: 'renew-current',
  RETURN_UNCHANGED_GRACE: 'return-unchanged-grace',
  REJECT_RETIRED: 'reject-retired',
  REJECT_EXPIRED: 'reject-expired',
  REJECT_REVOKED: 'reject-revoked'
} as const

export type ConfirmableResumeTuple = z.infer<typeof ConfirmableResumeTupleSchema>
