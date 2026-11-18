import { z } from 'zod'
import {
  Base64Url32ByteSchema,
  CanonicalHttpsOriginSchema,
  EpochMsSchema,
  GenerationSchema,
  RelayHostIdSchema
} from './wire-scalars.js'
import { RelayRegionSchema } from './relay-regions.js'
import {
  RegionCorrectionRequestSchema,
  RegionCorrectionResponseSchema
} from './region-correction.js'

const SignedAssignmentLeaseSchema = z
  .string()
  .min(1)
  .max(8 * 1024)

export const AssignmentRequestSchema = z
  .object({
    v: z.literal(1),
    relayHostId: RelayHostIdSchema,
    // Verify client-declared reconnect against durable assignment before fast-lane admission.
    reconnect: z.boolean().optional(),
    preferredRegion: RelayRegionSchema.optional(),
    regionCorrection: RegionCorrectionRequestSchema.optional()
  })
  .strict()

export const AssignmentResponseSchema = z
  .object({
    v: z.literal(1),
    cellUrl: CanonicalHttpsOriginSchema,
    assignmentEpoch: GenerationSchema,
    lease: SignedAssignmentLeaseSchema,
    regionCorrection: RegionCorrectionResponseSchema.optional(),
    // Other origins that reach the same edge host session as cellUrl (the edge's own URL and a
    // front door), in order of preference; never equal to cellUrl. Sent only when the request carried
    // RELAY_HOST_CAPABILITY_ORIGIN_ALTERNATES in RELAY_HOST_CAPABILITIES_HEADER.
    alternateCellUrls: z.array(CanonicalHttpsOriginSchema).min(1).max(2).optional(),
    // The front door origin this answer routes through, which also serves POST
    // /v1/desktop/auth/refresh and /v1/desktop/auth/relay-token; a second origin for token renewal.
    // Sent only when the request carried RELAY_HOST_CAPABILITY_FRONT_DOOR_AUTH.
    authOrigin: CanonicalHttpsOriginSchema.optional()
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
