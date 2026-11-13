import { describe, expect, it } from 'vitest'
import { decideResumeCommit, TokenFamilySchema } from './persistence-invariants.js'

const HASH = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

describe('relay persistence invariants', () => {
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
