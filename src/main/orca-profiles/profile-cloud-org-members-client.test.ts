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
})
