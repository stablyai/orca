import { z } from 'zod'
import { Base64Url32ByteSchema, EpochMsSchema, OpaqueIdSchema, RelayHostIdSchema } from './wire-scalars.js'

export const INVITE_STATE = {
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  COOLDOWN: 'cooldown',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
  INVALIDATED: 'invalidated'
} as const

export const InviteRecordSchema = z
  .object({
    relayDeviceId: OpaqueIdSchema,
    tokenHash: Base64Url32ByteSchema,
    state: z.nativeEnum(INVITE_STATE),
    attemptCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    expiresAt: EpochMsSchema,
    reservationId: OpaqueIdSchema.optional(),
    reservationExpiresAt: EpochMsSchema.optional(),
    cooldownUntil: EpochMsSchema.optional()
  })
  .strict()
  .superRefine((invite, context) => {
    if (
      invite.state === INVITE_STATE.RESERVED &&
      (!invite.reservationId || !invite.reservationExpiresAt)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'reserved invite requires a lease' })
    }
    if (invite.state === INVITE_STATE.COOLDOWN && invite.cooldownUntil === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cooldown invite requires cooldownUntil'
      })
    }
  })

export type InviteRecord = z.infer<typeof InviteRecordSchema>

export type InviteEvent =
  | { type: 'reserve'; reservationId: string; reservationExpiresAt: number }
  | { type: 'attach-failed'; cooldownUntil: number }
  | { type: 'lease-expired'; cooldownUntil: number }
  | { type: 'provision-committed' }
  | { type: 'direct-install-committed' }
  | { type: 'transaction-rollback' }
  | { type: 'cleanup' }

function withoutLease(invite: InviteRecord): InviteRecord {
  const { reservationId: _reservationId, reservationExpiresAt: _reservationExpiresAt, ...rest } = invite
  return rest
}

export function transitionInvite(invite: InviteRecord, event: InviteEvent, now: number): InviteRecord {
  if (event.type === 'transaction-rollback') return invite
  if (event.type === 'direct-install-committed') {
    return { ...withoutLease(invite), state: INVITE_STATE.INVALIDATED }
  }
  if (event.type === 'provision-committed') {
    return { ...withoutLease(invite), state: INVITE_STATE.CONSUMED }
  }
  if (event.type === 'cleanup') {
    if (now >= invite.expiresAt) return { ...withoutLease(invite), state: INVITE_STATE.EXPIRED }
    if (
      invite.state === INVITE_STATE.RESERVED &&
      invite.reservationExpiresAt !== undefined &&
      now >= invite.reservationExpiresAt
    ) {
      const state =
        invite.attemptCount >= invite.maxAttempts ? INVITE_STATE.INVALIDATED : INVITE_STATE.COOLDOWN
      return { ...withoutLease(invite), state, cooldownUntil: now }
    }
    return invite
  }
  if (event.type === 'reserve') {
    const available =
      invite.state === INVITE_STATE.AVAILABLE ||
      (invite.state === INVITE_STATE.COOLDOWN && (invite.cooldownUntil ?? 0) <= now)
    if (!available || now >= invite.expiresAt || invite.attemptCount >= invite.maxAttempts) return invite
    return {
      ...invite,
      state: INVITE_STATE.RESERVED,
      attemptCount: invite.attemptCount + 1,
      reservationId: event.reservationId,
      reservationExpiresAt: event.reservationExpiresAt,
      cooldownUntil: undefined
    }
  }
  if (invite.state !== INVITE_STATE.RESERVED) return invite
  const state =
    invite.attemptCount >= invite.maxAttempts ? INVITE_STATE.INVALIDATED : INVITE_STATE.COOLDOWN
  return { ...withoutLease(invite), state, cooldownUntil: event.cooldownUntil }
}

export const PAIRING_RECOVERY_MATRIX = [
  'direct-commit-ack',
  'direct-commit-response-lost',
  'direct-no-commit-invite-fallback',
  'late-direct-versus-invite-global-key'
] as const

export const CredentialInstallIdentitySchema = z
  .object({
    userId: OpaqueIdSchema,
    relayHostId: RelayHostIdSchema,
    relayDeviceId: OpaqueIdSchema,
    reqId: OpaqueIdSchema
  })
  .strict()

export const INSTALL_STATUS = {
  NOT_FOUND: 'not-found',
  COMMITTED: 'committed'
} as const

export const INSTALL_TRANSACTION_CONTRACT = {
  idempotencyKeyFields: ['userId', 'relayHostId', 'relayDeviceId', 'reqId'],
  transactionDeadlineMs: 10 * 1000,
  lockAttemptTimeoutMs: 2 * 1000,
  maxDeadlockRetries: 3,
  atomicEffects: ['idempotency-result', 'token-family', 'affected-invites']
} as const

export function nextCredentialVersion(currentVersion: number | undefined): number {
  return currentVersion === undefined ? 1 : currentVersion + 1
}

export const TokenFamilySchema = z
  .object({
    currentVersion: z.number().int().positive(),
    currentHash: Base64Url32ByteSchema,
    currentExpiresAt: EpochMsSchema,
    graceVersion: z.number().int().positive().optional(),
    graceHash: Base64Url32ByteSchema.optional(),
    graceExpiresAt: EpochMsSchema.optional(),
    revokedAt: EpochMsSchema.optional()
  })
  .strict()
  .superRefine((family, context) => {
    const graceFields = [family.graceVersion, family.graceHash, family.graceExpiresAt]
    if (graceFields.some((value) => value !== undefined) && graceFields.some((value) => value === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'grace fields must be all present or absent' })
    }
    if (family.graceVersion !== undefined && family.graceVersion >= family.currentVersion) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'grace version must precede current' })
    }
  })

export type ResumeCommitDecision =
  | 'renew-current'
  | 'return-unchanged-grace'
  | 'reject-retired'
  | 'reject-expired'
  | 'reject-revoked'

export function decideResumeCommit(
  family: z.infer<typeof TokenFamilySchema>,
  acceptedVersion: number,
  now: number
): ResumeCommitDecision {
  if (family.revokedAt !== undefined && family.revokedAt <= now) return 'reject-revoked'
  if (acceptedVersion === family.currentVersion) {
    return family.currentExpiresAt > now ? 'renew-current' : 'reject-expired'
  }
  if (acceptedVersion === family.graceVersion) {
    return (family.graceExpiresAt ?? 0) > now ? 'return-unchanged-grace' : 'reject-expired'
  }
  return 'reject-retired'
}
