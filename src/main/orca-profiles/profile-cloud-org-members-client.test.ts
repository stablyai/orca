import { describe, expect, it } from 'vitest'
import { normalizeRoster } from './cloud-org/profile-cloud-org-members-client'

describe('normalizeRoster', () => {
  it('keeps https profile pictures and drops anything else', () => {
    const roster = normalizeRoster({
      viewerRole: 'member',
      canManageMembers: false,
      pendingInvites: [],
      members: [
        {
          userId: 'a',
          email: 'a@x.dev',
          role: 'member',
          pictureUrl: 'https://img.propelauth.com/a.png'
        },
        { userId: 'b', email: 'b@x.dev', role: 'member', pictureUrl: 'http://x.dev/b.png' },
        { userId: 'c', email: 'c@x.dev', role: 'member', pictureUrl: 'javascript:alert(1)' },
        { userId: 'd', email: 'd@x.dev', role: 'member', pictureUrl: 'file:///etc/passwd' },
        { userId: 'e', email: 'e@x.dev', role: 'member' }
      ]
    })
    expect(roster.members.map((m) => m.pictureUrl)).toEqual([
      'https://img.propelauth.com/a.png',
      undefined,
      undefined,
      undefined,
      undefined
    ])
    expect('pictureUrl' in roster.members[4]!).toBe(false)
  })

  it('keeps a known MFA status and drops anything else', () => {
    const roster = normalizeRoster({
      viewerRole: 'owner',
      canManageMembers: true,
      pendingInvites: [],
      members: [
        { userId: 'a', email: 'a@x.dev', role: 'owner', mfa: 'on' },
        { userId: 'b', email: 'b@x.dev', role: 'member', mfa: 'off', mfaDeadline: 5 },
        { userId: 'c', email: 'c@x.dev', role: 'member', mfa: 'pending', mfaDeadline: 1_800_000 },
        { userId: 'd', email: 'd@x.dev', role: 'member', mfa: 'pending', mfaDeadline: 'soon' },
        { userId: 'e', email: 'e@x.dev', role: 'member', mfa: true },
        { userId: 'f', email: 'f@x.dev', role: 'member' }
      ]
    })
    expect(roster.members.map((m) => [m.mfa, m.mfaDeadline])).toEqual([
      ['on', undefined],
      // A deadline only means something while the member is pending.
      ['off', undefined],
      ['pending', 1_800_000],
      ['pending', undefined],
      [undefined, undefined],
      [undefined, undefined]
    ])
    expect('mfa' in roster.members[5]!).toBe(false)
  })
})
