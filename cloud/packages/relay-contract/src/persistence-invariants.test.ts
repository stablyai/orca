import { describe, expect, it } from 'vitest'
import { hasAdmissionCapacity } from './admission-budgets.js'
import {
  ASSIGNMENT_LIMITS,
  AssignmentActivitySchema,
  hasAssignmentActivity,
  mayNormallyReassign
} from './assignment-invariants.js'
import {
  CredentialInstallIdentitySchema,
  decideResumeCommit,
  InviteRecordSchema,
  INVITE_STATE,
  TokenFamilySchema
} from './persistence-invariants.js'

const HASH = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

describe('relay persistence invariants', () => {
  it('admits pre-auth sockets only outside every reserved budget', () => {
    expect(
      hasAdmissionCapacity({
        totalRequests: 649,
        preAuthConnections: 44,
        sourcePreAuthConnections: 3
      })
    ).toBe(true)
    expect(
      hasAdmissionCapacity({
        totalRequests: 650,
        preAuthConnections: 0,
        sourcePreAuthConnections: 0
      })
    ).toBe(false)
    expect(
      hasAdmissionCapacity({
        totalRequests: 0,
        preAuthConnections: 45,
        sourcePreAuthConnections: 0
      })
    ).toBe(false)
    expect(
      hasAdmissionCapacity({ totalRequests: 0, preAuthConnections: 0, sourcePreAuthConnections: 4 })
    ).toBe(false)
    expect(
      hasAdmissionCapacity({
        totalRequests: 2_899,
        preAuthConnections: 0,
        sourcePreAuthConnections: 0,
        totalRequestCeiling: 2_900
      })
    ).toBe(true)
    expect(
      hasAdmissionCapacity({
        totalRequests: 2_900,
        preAuthConnections: 0,
        sourcePreAuthConnections: 0,
        totalRequestCeiling: 2_900
      })
    ).toBe(false)
  })

  it('requires reservation identity and expiry in persisted invite leases', () => {
    expect(
      InviteRecordSchema.safeParse({
        relayDeviceId: 'device-1',
        tokenHash: HASH,
        state: INVITE_STATE.RESERVED,
        attemptCount: 1,
        maxAttempts: 5,
        expiresAt: 100,
        reservationId: 'reservation-1',
        reservationExpiresAt: 50
      }).success
    ).toBe(true)
    expect(
      InviteRecordSchema.safeParse({
        relayDeviceId: 'device-1',
        tokenHash: HASH,
        state: INVITE_STATE.RESERVED,
        attemptCount: 1,
        maxAttempts: 5,
        expiresAt: 100
      }).success
    ).toBe(false)
    expect(
      CredentialInstallIdentitySchema.safeParse({
        userId: 'user-1',
        relayHostId: 'abcdefghijklmnop',
        relayDeviceId: 'device-1',
        reqId: 'req-1'
      }).success
    ).toBe(true)
  })

  it('makes commit-time current, grace, retired, expired, and revoked outcomes exact', () => {
    const family = TokenFamilySchema.parse({
      currentVersion: 3,
      currentHash: HASH,
      currentExpiresAt: 200,
      graceVersion: 2,
      graceHash: HASH,
      graceExpiresAt: 150
    })
    expect(decideResumeCommit(family, 3, 100)).toBe('renew-current')
    expect(decideResumeCommit(family, 2, 100)).toBe('return-unchanged-grace')
    expect(decideResumeCommit(family, 1, 100)).toBe('reject-retired')
    expect(decideResumeCommit(family, 2, 149)).toBe('return-unchanged-grace')
    expect(decideResumeCommit(family, 2, 150)).toBe('reject-expired')
    expect(decideResumeCommit(family, 3, 200)).toBe('reject-expired')
    expect(decideResumeCommit({ ...family, revokedAt: 90 }, 3, 100)).toBe('reject-revoked')
  })

  it('counts every durable activity class before normal reassignment', () => {
    const record = AssignmentActivitySchema.parse({
      relayHostId: 'abcdefghijklmnop',
      cellId: 'cell-1',
      assignmentEpoch: 1,
      leaseExpiresAt: 100,
      lastActivityAt: 100,
      reservedControls: 0,
      reservedSplices: 0,
      reservedInvites: 0,
      pendingInstalls: 0,
      pendingConfirmations: 0,
      migrationLeases: 0
    })
    const dormantAt = 100 + ASSIGNMENT_LIMITS.dormantTtlMs
    expect(hasAssignmentActivity(record)).toBe(false)
    expect(mayNormallyReassign(record, dormantAt - 1)).toBe(false)
    expect(mayNormallyReassign(record, dormantAt)).toBe(true)
    for (const counter of [
      'reservedControls',
      'reservedSplices',
      'reservedInvites',
      'pendingInstalls',
      'pendingConfirmations',
      'migrationLeases'
    ]) {
      const active = { ...record, [counter]: 1 }
      expect(hasAssignmentActivity(active), counter).toBe(true)
      expect(mayNormallyReassign(active, dormantAt), counter).toBe(false)
    }
  })
})
