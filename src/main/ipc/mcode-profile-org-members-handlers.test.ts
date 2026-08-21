import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  listMCodeProfileOrgMembersMock,
  inviteMCodeProfileOrgMemberMock,
  revokeMCodeProfileOrgInviteMock,
  changeMCodeProfileOrgMemberRoleMock,
  removeMCodeProfileOrgMemberMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  listMCodeProfileOrgMembersMock: vi.fn(),
  inviteMCodeProfileOrgMemberMock: vi.fn(),
  revokeMCodeProfileOrgInviteMock: vi.fn(),
  changeMCodeProfileOrgMemberRoleMock: vi.fn(),
  removeMCodeProfileOrgMemberMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../mcode-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/mcode-user-data'
}))

vi.mock('../mcode-profiles/profile-cloud-org-members-service', () => ({
  listMCodeProfileOrgMembers: listMCodeProfileOrgMembersMock,
  inviteMCodeProfileOrgMember: inviteMCodeProfileOrgMemberMock,
  revokeMCodeProfileOrgInvite: revokeMCodeProfileOrgInviteMock,
  changeMCodeProfileOrgMemberRole: changeMCodeProfileOrgMemberRoleMock,
  removeMCodeProfileOrgMember: removeMCodeProfileOrgMemberMock
}))

import { registerMCodeProfileOrgMemberHandlers } from './mcode-profile-org-members-handlers'

function invoke(channel: string, args?: unknown): unknown {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`No handler for ${channel}`)
  }
  return handler({}, args)
}

describe('registerMCodeProfileOrgMemberHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    listMCodeProfileOrgMembersMock.mockReset().mockResolvedValue({ status: 'ok', roster: {} })
    inviteMCodeProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    revokeMCodeProfileOrgInviteMock.mockReset().mockResolvedValue({ status: 'ok' })
    changeMCodeProfileOrgMemberRoleMock.mockReset().mockResolvedValue({ status: 'ok' })
    removeMCodeProfileOrgMemberMock.mockReset().mockResolvedValue({ status: 'ok' })
    registerMCodeProfileOrgMemberHandlers()
  })

  it('registers all five org-member channels', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        'mcodeProfiles:orgInviteRevoke',
        'mcodeProfiles:orgMemberChangeRole',
        'mcodeProfiles:orgMemberInvite',
        'mcodeProfiles:orgMemberRemove',
        'mcodeProfiles:orgMembersList'
      ].sort()
    )
  })

  it('forwards a valid invite to the service with a trimmed email', async () => {
    await invoke('mcodeProfiles:orgMemberInvite', {
      orgId: 'org-1',
      email: '  new@example.com  ',
      role: 'admin'
    })
    expect(inviteMCodeProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/mcode-user-data', {
      orgId: 'org-1',
      email: 'new@example.com',
      role: 'admin'
    })
  })

  it('rejects an invite with a missing org id', async () => {
    await expect(
      invoke('mcodeProfiles:orgMemberInvite', { email: 'a@b.com', role: 'member' })
    ).rejects.toThrow('invalid_mcode_profile_org_selection')
    expect(inviteMCodeProfileOrgMemberMock).not.toHaveBeenCalled()
  })

  it('rejects an invite with an unknown role', async () => {
    await expect(
      invoke('mcodeProfiles:orgMemberInvite', { orgId: 'org-1', email: 'a@b.com', role: 'root' })
    ).rejects.toThrow('invalid_mcode_org_role')
  })

  it('rejects a role change with a blank user id', async () => {
    await expect(
      invoke('mcodeProfiles:orgMemberChangeRole', { orgId: 'org-1', userId: '  ', role: 'admin' })
    ).rejects.toThrow('invalid_mcode_org_member_user')
  })

  it('forwards remove and revoke with validated args', async () => {
    await invoke('mcodeProfiles:orgMemberRemove', { orgId: 'org-1', userId: 'user-2' })
    expect(removeMCodeProfileOrgMemberMock).toHaveBeenCalledWith('/tmp/mcode-user-data', {
      orgId: 'org-1',
      userId: 'user-2'
    })
    await invoke('mcodeProfiles:orgInviteRevoke', { orgId: 'org-1', email: 'gone@b.com' })
    expect(revokeMCodeProfileOrgInviteMock).toHaveBeenCalledWith('/tmp/mcode-user-data', {
      orgId: 'org-1',
      email: 'gone@b.com'
    })
  })
})
