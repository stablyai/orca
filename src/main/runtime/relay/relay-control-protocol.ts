import { z } from 'zod'
import type { RawData } from 'ws'
import {
  DeviceCredentialInstalledSchema,
  DeviceResumeConfirmedSchema
} from '../../../shared/mobile-relay-credential-contract'

const OpaqueIdSchema = z.string().min(1).max(128)
const Base64Url32ByteSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const Base6432ByteSchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
const Base64Raw24ByteSchema = z.string().regex(/^[A-Za-z0-9+/]{32}$/)
const EpochMsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const GenerationSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const RelayHostChallengeMessageSchema = z
  .object({
    type: z.literal('host-challenge'),
    challengeId: OpaqueIdSchema,
    relayEphemeralPublicKeyB64: Base6432ByteSchema,
    nonceB64: Base64Raw24ByteSchema,
    ciphertextB64: z
      .string()
      .min(1)
      .max(16 * 1024),
    expiresAt: EpochMsSchema
  })
  .strict()

const PendingConnectionSchema = z
  .object({ connId: OpaqueIdSchema, connTicket: Base64Url32ByteSchema })
  .strict()

export const RelayHostHelloAckMessageSchema = z
  .object({
    type: z.literal('host-hello-ack'),
    v: z.literal(1),
    generation: GenerationSchema,
    controlResumeSecret: Base64Url32ByteSchema,
    leaseExpiresAt: EpochMsSchema,
    activeConnIds: z.array(OpaqueIdSchema).max(8),
    pendingConns: z.array(PendingConnectionSchema).max(8)
  })
  .strict()

export const RelayConnectionOpenMessageSchema = z
  .object({
    type: z.literal('conn-open'),
    connId: OpaqueIdSchema,
    connTicket: Base64Url32ByteSchema,
    kind: z.enum(['invite', 'resume']),
    relayDeviceId: OpaqueIdSchema,
    attachDeadlineMs: z.number().int().positive().max(60_000)
  })
  .strict()

export const RelayDrainMessageSchema = z
  .object({
    type: z.literal('drain'),
    graceMs: z
      .number()
      .int()
      .nonnegative()
      .max(60 * 60 * 1000),
    recovery: z.literal('resolve-director')
  })
  .strict()

export const RelayPingMessageSchema = z
  .object({ type: z.literal('ping'), t: EpochMsSchema })
  .strict()

export const RelayInviteCreatedMessageSchema = z
  .object({
    type: z.literal('invite-created'),
    reqId: OpaqueIdSchema,
    inviteToken: Base64Url32ByteSchema,
    expiresAt: EpochMsSchema,
    maxAttempts: z.number().int().positive().max(16)
  })
  .strict()

export const RelayDeviceRevokedMessageSchema = z
  .object({ type: z.literal('device-revoked'), reqId: OpaqueIdSchema })
  .strict()

export const RelayDeviceCredentialInstalledMessageSchema = DeviceCredentialInstalledSchema.extend({
  type: z.literal('device-credential-installed')
}).strict()

export const RelayDeviceCredentialInstallStatusResultMessageSchema = z.union([
  z
    .object({
      type: z.literal('device-credential-install-status-result'),
      v: z.literal(1),
      reqId: OpaqueIdSchema,
      state: z.literal('not-found')
    })
    .strict(),
  z
    .object({
      type: z.literal('device-credential-install-status-result'),
      v: z.literal(1),
      reqId: OpaqueIdSchema,
      state: z.literal('committed'),
      result: DeviceCredentialInstalledSchema
    })
    .strict()
])

export const RelayDeviceResumeConfirmedMessageSchema = DeviceResumeConfirmedSchema.extend({
  type: z.literal('device-resume-confirmed')
}).strict()

export const RelayControlErrorMessageSchema = z
  .object({
    type: z.literal('control-error'),
    reqId: OpaqueIdSchema.optional(),
    code: z.string().min(1).max(128)
  })
  .strict()

export type RelayHostChallengeMessage = z.infer<typeof RelayHostChallengeMessageSchema>
export type RelayHostHelloAckMessage = z.infer<typeof RelayHostHelloAckMessageSchema>
export type RelayConnectionOpenMessage = z.infer<typeof RelayConnectionOpenMessageSchema>
export type RelayDrainMessage = z.infer<typeof RelayDrainMessageSchema>
export type RelayInviteCreatedMessage = z.infer<typeof RelayInviteCreatedMessageSchema>
export type RelayDeviceCredentialInstalledMessage = z.infer<
  typeof RelayDeviceCredentialInstalledMessageSchema
>
export type RelayDeviceCredentialInstallStatusResultMessage = z.infer<
  typeof RelayDeviceCredentialInstallStatusResultMessageSchema
>
export type RelayDeviceResumeConfirmedMessage = z.infer<
  typeof RelayDeviceResumeConfirmedMessageSchema
>

export function parseRelayControlMessage(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw.toString()) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
