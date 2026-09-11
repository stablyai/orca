import { z } from 'zod'
import {
  Base64Url32ByteSchema,
  CanonicalHttpsOriginSchema,
  EpochMsSchema,
  GenerationSchema,
  RelayHostIdSchema
} from './wire-scalars.js'
import { RelayRegionSchema } from './relay-regions.js'

const SignedAssignmentLeaseSchema = z.string().min(1).max(8 * 1024)

export const AssignmentRequestSchema = z
  .object({
    v: z.literal(1),
    relayHostId: RelayHostIdSchema,
    // Client-declared reconnection; the director verifies it against the
    // durable assignment before granting fast-lane admission.
    reconnect: z.boolean().optional(),
    preferredRegion: RelayRegionSchema.optional()
  })
  .strict()

export const AssignmentResponseSchema = z
  .object({
    v: z.literal(1),
    cellUrl: CanonicalHttpsOriginSchema,
    assignmentEpoch: GenerationSchema,
    lease: SignedAssignmentLeaseSchema
  })
  .strict()

export const ResolveRequestSchema = z
  .object({
    v: z.literal(1),
    relayHostId: RelayHostIdSchema,
    resumeToken: Base64Url32ByteSchema
  })
  .strict()

export const ResolveResponseSchema = z
  .object({
    v: z.literal(1),
    cellUrl: CanonicalHttpsOriginSchema,
    assignmentEpoch: GenerationSchema,
    leaseExpiresAt: EpochMsSchema
  })
  .strict()

export const RelayMovedSchema = z
  .object({
    v: z.literal(1),
    cellUrl: CanonicalHttpsOriginSchema,
    assignmentEpoch: GenerationSchema
  })
  .strict()

export function isTrustedNewerMove(input: {
  sourceOrigin: string
  configuredDirectorOrigin: string
  currentAssignmentEpoch: number
  move: z.infer<typeof RelayMovedSchema>
}): boolean {
  // Why: cells and stale director responses must never redirect a credential-bearing client.
  return (
    input.sourceOrigin === input.configuredDirectorOrigin &&
    input.move.assignmentEpoch > input.currentAssignmentEpoch
  )
}

export type AssignmentRequest = z.infer<typeof AssignmentRequestSchema>
export type AssignmentResponse = z.infer<typeof AssignmentResponseSchema>
export type ResolveRequest = z.infer<typeof ResolveRequestSchema>
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>
export type RelayMoved = z.infer<typeof RelayMovedSchema>
