import { beforeEach, describe, expect, it } from 'vitest'
import {
  _getDevOrcaCloudOrgRosterCountForTests,
  _resetDevOrcaCloudOrgRostersForTests,
  DEV_ORG_PENDING_INVITE_MAX_ENTRIES,
  DEV_ORG_ROSTER_MAX_ENTRIES,
  inviteDevOrcaCloudOrgMember,
  listDevOrcaCloudOrgMembers
} from './profile-cloud-dev-org-members'

beforeEach(() => {
  _resetDevOrcaCloudOrgRostersForTests()
})

describe('dev organization roster retention', () => {
  it('bounds retained organizations while keeping recently used rosters', () => {
    for (let index = 0; index <= DEV_ORG_ROSTER_MAX_ENTRIES; index += 1) {
      listDevOrcaCloudOrgMembers(`org-${index}`)
    }
    expect(_getDevOrcaCloudOrgRosterCountForTests()).toBe(DEV_ORG_ROSTER_MAX_ENTRIES)
  })

  it('bounds pending invites within one retained roster', () => {
    const orgId = 'invite-heavy-org'
    for (let index = 1; index < DEV_ORG_PENDING_INVITE_MAX_ENTRIES; index += 1) {
      expect(
        inviteDevOrcaCloudOrgMember({
          orgId,
          email: `person-${index}@example.com`,
          role: 'member'
        })
      ).toEqual({ status: 'ok' })
    }
    expect(
      inviteDevOrcaCloudOrgMember({
        orgId,
        email: 'overflow@example.com',
        role: 'member'
      })
    ).toEqual({ status: 'failed', error: 'The dev organization invite roster is full.' })
  })

  it('does not retain oversized invitation text', () => {
    expect(
      inviteDevOrcaCloudOrgMember({
        orgId: 'org',
        email: `${'x'.repeat(321)}@example.com`,
        role: 'member'
      })
    ).toEqual({ status: 'failed', error: 'The dev organization invite roster is full.' })
    expect(listDevOrcaCloudOrgMembers('org').pendingInvites).toHaveLength(1)
  })
})
