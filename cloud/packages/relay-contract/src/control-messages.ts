import { z } from 'zod'
import {
  Base6432ByteSchema,
  Base64Raw24ByteSchema,
  Base64Url32ByteSchema,
  EpochMsSchema,
  GenerationSchema,
  OpaqueIdSchema,
  PositiveDurationMsSchema,
  RelayHostIdSchema
} from './wire-scalars.js'

const AppVersionSchema = z.string().min(1).max(128)
const BoundedCiphertextSchema = z
  .string()
  .min(1)
  .max(16 * 1024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
const ConnectionKindSchema = z.enum(['invite', 'resume'])

export const HostHelloSchema = z
  .object({
    v: z.literal(1),
    relayHostId: RelayHostIdSchema,
    assignmentEpoch: GenerationSchema,
    hostPublicKeyB64: Base6432ByteSchema,
    appVersion: AppVersionSchema,
    previousGeneration: GenerationSchema.optional(),
    controlResumeSecret: Base64Url32ByteSchema.optional()
  })
  .strict()

export const HostChallengeSchema = z
  .object({
    challengeId: OpaqueIdSchema,
    relayEphemeralPublicKeyB64: Base6432ByteSchema,
    nonceB64: Base64Raw24ByteSchema,
    ciphertextB64: BoundedCiphertextSchema,
    expiresAt: EpochMsSchema
  })
  .strict()

export const HostChallengeAckSchema = z
  .object({ challengeId: OpaqueIdSchema, proofB64: Base6432ByteSchema })
  .strict()

const PendingConnectionSchema = z
  .object({ connId: OpaqueIdSchema, connTicket: Base64Url32ByteSchema })
  .strict()

export const HostHelloAckSchema = z
  .object({
    v: z.literal(1),
    generation: GenerationSchema,
    controlResumeSecret: Base64Url32ByteSchema,
    leaseExpiresAt: EpochMsSchema,
    activeConnIds: z.array(OpaqueIdSchema).max(8),
    pendingConns: z.array(PendingConnectionSchema).max(8)
  })
  .strict()

export const ConnectionOpenSchema = z
  .object({
    connId: OpaqueIdSchema,
    connTicket: Base64Url32ByteSchema,
    kind: ConnectionKindSchema,
    relayDeviceId: OpaqueIdSchema,
    attachDeadlineMs: PositiveDurationMsSchema
  })
  .strict()

export const HostDataAuthSchema = z
  .object({
    v: z.literal(1),
    connTicket: Base64Url32ByteSchema,
    generation: GenerationSchema
  })
  .strict()

export const InviteCreateSchema = z
  .object({ reqId: OpaqueIdSchema, relayDeviceId: OpaqueIdSchema })
  .strict()

export const InviteCreatedSchema = z
  .object({
    reqId: OpaqueIdSchema,
    inviteToken: Base64Url32ByteSchema,
    expiresAt: EpochMsSchema,
    maxAttempts: z.number().int().positive().max(16)
  })
  .strict()

export const DeviceRevokeSchema = z
  .object({ reqId: OpaqueIdSchema, relayDeviceId: OpaqueIdSchema })
  .strict()

export const AuthRefreshSchema = z.object({ relayJwt: z.string().min(1).max(8 * 1024) }).strict()

export const DrainSchema = z
  .object({
    graceMs: z.number().int().nonnegative().max(60 * 60 * 1000),
    recovery: z.literal('resolve-director')
  })
  .strict()

export const HeartbeatSchema = z.object({ t: EpochMsSchema }).strict()

export type HostHello = z.infer<typeof HostHelloSchema>
export type HostChallenge = z.infer<typeof HostChallengeSchema>
export type HostChallengeAck = z.infer<typeof HostChallengeAckSchema>
export type HostHelloAck = z.infer<typeof HostHelloAckSchema>
export type ConnectionOpen = z.infer<typeof ConnectionOpenSchema>
export type HostDataAuth = z.infer<typeof HostDataAuthSchema>
export type InviteCreate = z.infer<typeof InviteCreateSchema>
export type InviteCreated = z.infer<typeof InviteCreatedSchema>
export type DeviceRevoke = z.infer<typeof DeviceRevokeSchema>
export type AuthRefresh = z.infer<typeof AuthRefreshSchema>
export type Drain = z.infer<typeof DrainSchema>
export type Heartbeat = z.infer<typeof HeartbeatSchema>
