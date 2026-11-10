import { describe, expect, it } from 'vitest'
import { hasAdmissionCapacity } from './admission-budgets.js'
import { decideResumeCommit, TokenFamilySchema } from './persistence-invariants.js'

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
})
