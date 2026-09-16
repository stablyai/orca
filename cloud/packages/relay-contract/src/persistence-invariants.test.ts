import { describe, expect, it } from 'vitest'
import { hasAdmissionCapacity, RELAY_ADMISSION_BUDGETS } from './admission-budgets.js'
import {
  ASSIGNMENT_LIMITS,
  AssignmentActivitySchema,
  EvacuationCommitSchema,
  hasAssignmentActivity,
  mayNormallyReassign
} from './assignment-invariants.js'
import {
  CONTROL_GENERATION_STATE,
  controlLossDisposition,
  mayStartNewRelayWork,
  preservesRelayAuthIdentity
} from './control-continuity.js'
import {
  CredentialInstallIdentitySchema,
  decideResumeCommit,
  INSTALL_TRANSACTION_CONTRACT,
  INSTALL_STATUS,
  InviteRecordSchema,
  INVITE_STATE,
  nextCredentialVersion,
  PAIRING_RECOVERY_MATRIX,
  transitionInvite,
  TokenFamilySchema
} from './persistence-invariants.js'

const HASH = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

describe('relay persistence invariants', () => {
  it('admits pre-auth sockets only outside every reserved budget', () => {
    expect(RELAY_ADMISSION_BUDGETS.maxProcessQueuedBytes).toBe(64 * 1024 * 1024)
    expect(hasAdmissionCapacity({ totalRequests: 649, preAuthConnections: 44, sourcePreAuthConnections: 3 })).toBe(true)
    expect(hasAdmissionCapacity({ totalRequests: 650, preAuthConnections: 0, sourcePreAuthConnections: 0 })).toBe(false)
    expect(hasAdmissionCapacity({ totalRequests: 0, preAuthConnections: 45, sourcePreAuthConnections: 0 })).toBe(false)
    expect(hasAdmissionCapacity({ totalRequests: 0, preAuthConnections: 0, sourcePreAuthConnections: 4 })).toBe(false)
    expect(hasAdmissionCapacity({
      totalRequests: 2_899,
      preAuthConnections: 0,
      sourcePreAuthConnections: 0,
      totalRequestCeiling: 2_900
    })).toBe(true)
    expect(hasAdmissionCapacity({
      totalRequests: 2_900,
      preAuthConnections: 0,
      sourcePreAuthConnections: 0,
      totalRequestCeiling: 2_900
    })).toBe(false)
  })

  it('represents persisted invite leases without an intermediate install status', () => {
    expect(Object.values(INSTALL_STATUS)).toEqual(['not-found', 'committed'])
    expect(INSTALL_TRANSACTION_CONTRACT.atomicEffects).toEqual([
      'idempotency-result', 'token-family', 'affected-invites'
    ])
    expect(nextCredentialVersion(undefined)).toBe(1)
    expect(nextCredentialVersion(3)).toBe(4)
    expect(
      InviteRecordSchema.safeParse({
        relayDeviceId: 'device-1', tokenHash: HASH, state: INVITE_STATE.RESERVED,
        attemptCount: 1, maxAttempts: 5, expiresAt: 100, reservationId: 'reservation-1',
        reservationExpiresAt: 50
      }).success
    ).toBe(true)
    expect(
      InviteRecordSchema.safeParse({
        relayDeviceId: 'device-1', tokenHash: HASH, state: INVITE_STATE.RESERVED,
        attemptCount: 1, maxAttempts: 5, expiresAt: 100
      }).success
    ).toBe(false)
    expect(
      CredentialInstallIdentitySchema.safeParse({
        userId: 'user-1', relayHostId: 'abcdefghijklmnop', relayDeviceId: 'device-1', reqId: 'req-1'
      }).success
    ).toBe(true)
  })

  it('leases, cools down, rolls back, consumes, invalidates, and cleans invites durably', () => {
    const available = InviteRecordSchema.parse({
      relayDeviceId: 'device-1', tokenHash: HASH, state: INVITE_STATE.AVAILABLE,
      attemptCount: 0, maxAttempts: 2, expiresAt: 1_000
    })
    const reserved = transitionInvite(
      available,
      { type: 'reserve', reservationId: 'reservation-1', reservationExpiresAt: 50 },
      10
    )
    expect(reserved.state).toBe(INVITE_STATE.RESERVED)
    expect(transitionInvite(reserved, { type: 'transaction-rollback' }, 20)).toBe(reserved)
    const cooldown = transitionInvite(reserved, { type: 'lease-expired', cooldownUntil: 60 }, 50)
    expect(cooldown.state).toBe(INVITE_STATE.COOLDOWN)
    const second = transitionInvite(
      cooldown,
      { type: 'reserve', reservationId: 'reservation-2', reservationExpiresAt: 80 },
      60
    )
    expect(transitionInvite(second, { type: 'attach-failed', cooldownUntil: 90 }, 70).state).toBe(
      INVITE_STATE.INVALIDATED
    )
    expect(transitionInvite(reserved, { type: 'provision-committed' }, 20).state).toBe(
      INVITE_STATE.CONSUMED
    )
    expect(transitionInvite(available, { type: 'direct-install-committed' }, 20).state).toBe(
      INVITE_STATE.INVALIDATED
    )
    expect(transitionInvite(available, { type: 'cleanup' }, 1_000).state).toBe(INVITE_STATE.EXPIRED)
    expect(PAIRING_RECOVERY_MATRIX).toHaveLength(4)
  })

  it('makes commit-time current, grace, retired, expired, and revoked outcomes exact', () => {
    const family = TokenFamilySchema.parse({
      currentVersion: 3, currentHash: HASH, currentExpiresAt: 200,
      graceVersion: 2, graceHash: HASH, graceExpiresAt: 150
    })
    expect(decideResumeCommit(family, 3, 100)).toBe('renew-current')
    expect(decideResumeCommit(family, 2, 100)).toBe('return-unchanged-grace')
    expect(decideResumeCommit(family, 1, 100)).toBe('reject-retired')
    expect(decideResumeCommit(family, 2, 151)).toBe('reject-expired')
    expect(decideResumeCommit({ ...family, revokedAt: 90 }, 3, 100)).toBe('reject-revoked')
  })

  it('distinguishes same-process rebind, replacement fencing, and drain-only work', () => {
    expect(controlLossDisposition({ matchingResumeSecret: true, competingGeneration: true })).toBe('rebind')
    expect(controlLossDisposition({ matchingResumeSecret: false, competingGeneration: true })).toBe('fence-old')
    expect(controlLossDisposition({ matchingResumeSecret: false, competingGeneration: false })).toBe('orphan-grace')
    expect(mayStartNewRelayWork(CONTROL_GENERATION_STATE.DRAIN_ONLY, false)).toBe(false)
    expect(mayStartNewRelayWork(CONTROL_GENERATION_STATE.ACTIVE, true)).toBe(false)
    const identity = { sub: 'u', prof: 'p', org: 'o', relayHostId: 'abcdefghijklmnop' }
    expect(preservesRelayAuthIdentity(identity, identity)).toBe(true)
    expect(preservesRelayAuthIdentity(identity, { ...identity, org: 'other' })).toBe(false)
  })

  it('counts every durable activity class before normal reassignment', () => {
    const record = AssignmentActivitySchema.parse({
      relayHostId: 'abcdefghijklmnop', cellId: 'cell-1', assignmentEpoch: 1,
      leaseExpiresAt: 100, lastActivityAt: 100, reservedControls: 0, reservedSplices: 0,
      reservedInvites: 0, pendingInstalls: 0, pendingConfirmations: 0, migrationLeases: 1
    })
    expect(hasAssignmentActivity(record)).toBe(true)
    expect(mayNormallyReassign(record, 100 + ASSIGNMENT_LIMITS.dormantTtlMs)).toBe(false)
    expect(mayNormallyReassign({ ...record, migrationLeases: 0 }, 100 + ASSIGNMENT_LIMITS.dormantTtlMs)).toBe(true)
    expect(
      EvacuationCommitSchema.safeParse({
        relayHostId: 'abcdefghijklmnop', sourceCellId: 'cell-1', targetCellId: 'cell-2',
        previousEpoch: 1, assignmentEpoch: 2, targetCapacityReserved: true
      }).success
    ).toBe(true)
    expect(
      EvacuationCommitSchema.safeParse({
        relayHostId: 'abcdefghijklmnop', sourceCellId: 'cell-1', targetCellId: 'cell-2',
        previousEpoch: 1, assignmentEpoch: 3, targetCapacityReserved: true
      }).success
    ).toBe(false)
  })
})
