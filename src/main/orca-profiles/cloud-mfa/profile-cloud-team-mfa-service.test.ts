import { describe, expect, it } from 'vitest'
import { normalizeTeamMfaPolicy, sameOriginUrl } from './profile-cloud-team-mfa-service'

const API = 'https://cloud.orca.dev'
const setupUrl = `${API}/v1/account/security`

describe('normalizeTeamMfaPolicy', () => {
  it('reads a member answer: the deadline and their own state, no manager fields', () => {
    expect(
      normalizeTeamMfaPolicy(
        { policy: { enforceAt: 200, setAt: 100 }, self: { mfa: 'pending' }, setupUrl },
        API
      )
    ).toEqual({ policy: { enforceAt: 200, setAt: 100 }, self: 'pending', setupUrl })
  })

  it('ignores the manager fields (the policy is managed in the web console)', () => {
    expect(
      normalizeTeamMfaPolicy(
        { policy: null, self: { mfa: 'on' }, setupUrl, available: false, pendingMembers: 3 },
        API
      )
    ).toEqual({ policy: null, self: 'on', setupUrl })
  })

  it('never turns a malformed state into blocked', () => {
    for (const self of [undefined, null, {}, { mfa: 'BLOCKED' }, { mfa: true }, 'blocked']) {
      expect(normalizeTeamMfaPolicy({ policy: null, self, setupUrl }, API).self).toBe('unknown')
    }
  })

  it('drops a half-formed deadline rather than guessing one', () => {
    expect(
      normalizeTeamMfaPolicy({ policy: { enforceAt: 'soon' }, self: { mfa: 'off' }, setupUrl }, API)
        .policy
    ).toBeNull()
  })

  it('refuses an answer whose setup link is not on Orca Cloud', () => {
    for (const link of ['https://evil.example/x', 'javascript:alert(1)', undefined, 7]) {
      expect(() =>
        normalizeTeamMfaPolicy({ policy: null, self: { mfa: 'off' }, setupUrl: link }, API)
      ).toThrow('invalid_orca_team_mfa_policy')
    }
    expect(sameOriginUrl('https://user:pw@cloud.orca.dev/x', API)).toBeNull()
    expect(sameOriginUrl('http://cloud.orca.dev/x', API)).toBeNull()
  })
})

describe('single sign-on', () => {
  it('reads the delegated state', () => {
    const read = normalizeTeamMfaPolicy(
      { policy: { enforceAt: 200, setAt: 100 }, self: { mfa: 'delegated' }, setupUrl },
      API
    )
    expect(read.self).toBe('delegated')
  })
})
