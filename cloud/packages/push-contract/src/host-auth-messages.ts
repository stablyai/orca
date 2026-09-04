import { z } from 'zod'
import {
  Base6432ByteSchema,
  Base64Raw24ByteSchema,
  Base64Url32ByteSchema,
  BoundedCiphertextSchema,
  EpochMsSchema,
  OpaqueIdSchema,
  PushHostFingerprintSchema
} from './wire-scalars.js'

export const PushHostChallengeRequestSchema = z
  .object({ v: z.literal(1), hostPublicKeyB64: Base6432ByteSchema })
  .strict()

export const PushHostChallengeResponseSchema = z
  .object({
    challengeId: OpaqueIdSchema,
    gatewayEphemeralPublicKeyB64: Base6432ByteSchema,
    nonceB64: Base64Raw24ByteSchema,
    ciphertextB64: BoundedCiphertextSchema,
    expiresAt: EpochMsSchema
  })
  .strict()

export const PushHostSessionRequestSchema = z
  .object({ v: z.literal(1), challengeId: OpaqueIdSchema, proofB64: Base6432ByteSchema })
  .strict()

export const PushHostSessionResponseSchema = z
  .object({
    sessionToken: Base64Url32ByteSchema,
    expiresAt: EpochMsSchema,
    hostFingerprint: PushHostFingerprintSchema
  })
  .strict()

export const PUSH_ERROR_CODES = [
  'invalid_request',
  'invalid_challenge',
  'invalid_proof',
  'invalid_token',
  'session_expired',
  'not_found',
  'request_too_large',
  'dependency_unavailable'
] as const

export const PushErrorResponseSchema = z
  .object({ error: z.enum(PUSH_ERROR_CODES) })
  .strict()

export type PushHostChallengeRequest = z.infer<typeof PushHostChallengeRequestSchema>
export type PushHostChallengeResponse = z.infer<typeof PushHostChallengeResponseSchema>
export type PushHostSessionRequest = z.infer<typeof PushHostSessionRequestSchema>
export type PushHostSessionResponse = z.infer<typeof PushHostSessionResponseSchema>
export type PushErrorCode = (typeof PUSH_ERROR_CODES)[number]
