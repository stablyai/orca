import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaOrgMembersRoster } from '../../shared/orca-profiles'
import { OrcaCloudRequestError } from './profile-cloud-client'

const {
  runWithFreshOrcaCloudSessionMock,
  listOrcaCloudOrgMembersMock,
  inviteOrcaCloudOrgMemberMock,
  revokeOrcaCloudOrgInviteMock,
  changeOrcaCloudOrgMemberRoleMock,
  removeOrcaCloudOrgMemberMock
} = vi.hoisted(() => ({
  runWithFreshOrcaCloudSessionMock: vi.fn(),
  listOrcaCloudOrgMembersMock: vi.fn(),
  inviteOrcaCloudOrgMemberMock: vi.fn(),
  revokeOrcaCloudOrgInviteMock: vi.fn(),
  changeOrcaCloudOrgMemberRoleMock: vi.fn(),
  removeOrcaCloudOrgMemberMock: vi.fn()
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

vi.mock('./profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSessionMock,
  runWithFreshOrcaCloudSession: runWithFreshOrcaCloudSessionMock
}))

vi.mock('./profile-cloud-org-members-client', () => ({
  listOrcaCloudOrgMembers: listOrcaCloudOrgMembersMock,
  inviteOrcaCloudOrgMember: inviteOrcaCloudOrgMemberMock,
  revokeOrcaCloudOrgInvite: revokeOrcaCloudOrgInviteMock,
  changeOrcaCloudOrgMemberRole: changeOrcaCloudOrgMemberRoleMock,
  removeOrcaCloudOrgMember: removeOrcaCloudOrgMemberMock
}))

import {
  changeOrcaProfileOrgMemberRole,
  inviteOrcaProfileOrgMember,
  listOrcaProfileOrgMembers,
  removeOrcaProfileOrgMember,
  revokeOrcaProfileOrgInvite
} from './profile-cloud-org-members-service'

const fakeSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  capabilities: { flags: {}, refreshedAt: 1 }
}

// Why: mirror the real contract — invoke the operation with a live session and
// surface its resolved value; business 4xx are returned by the operation as
// values, never thrown, so the session layer never sees them.
function runOperationDirectly(): void {
  runWithFreshOrcaCloudSessionMock.mockImplementation(
    async (
      _config: unknown,
      _active: unknown,
      _path: unknown,
      op: (session: unknown) => unknown
    ) => ({
      status: 'ok',
      value: await op(fakeSession)
    })
  )
}

function configureCloudEnv(): void {
  vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
  vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
}

const roster: OrcaOrgMembersRoster = {
  members: [{ userId: 'user-1', email: 'nina@example.com', role: 'owner' }],
  pendingInvites: [],
  viewerRole: 'owner',
  canManageMembers: true
}

describe('Orca cloud org members service (configured)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-org-members-'))
    runWithFreshOrcaCloudSessionMock.mockReset()
    listOrcaCloudOrgMembersMock.mockReset()
    inviteOrcaCloudOrgMemberMock.mockReset()
    revokeOrcaCloudOrgInviteMock.mockReset()
    changeOrcaCloudOrgMemberRoleMock.mockReset()
    removeOrcaCloudOrgMemberMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCA_CLOUD_DEV_AUTH', '')
    vi.stubEnv('ORCA_CLOUD_API_URL', '')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('reports unconfigured when cloud sign-in is not set up', async () => {
    await expect(listOrcaProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'unconfigured'
    })
    expect(runWithFreshOrcaCloudSessionMock).not.toHaveBeenCalled()
  })

  it('returns the roster from the client', async () => {
    configureCloudEnv()
    runOperationDirectly()
    listOrcaCloudOrgMembersMock.mockResolvedValue(roster)

    await expect(listOrcaProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'ok',
      roster
    })
    expect(listOrcaCloudOrgMembersMock).toHaveBeenCalledWith(
      expect.any(Object),
      fakeSession,
      'org-1'
    )
  })

  it('maps a 409 already_member invite conflict', async () => {
    configureCloudEnv()
    runOperationDirectly()
    inviteOrcaCloudOrgMemberMock.mockRejectedValue(new OrcaCloudRequestError(409, 'already_member'))

    await expect(
      inviteOrcaProfileOrgMember(userDataPath, { orgId: 'org-1', email: 'a@b.com', role: 'member' })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_member' })
  })

  it('maps a 403 role change to forbidden', async () => {
    configureCloudEnv()
    runOperationDirectly()
    changeOrcaCloudOrgMemberRoleMock.mockRejectedValue(new OrcaCloudRequestError(403))

    await expect(
      changeOrcaProfileOrgMemberRole(userDataPath, {
        orgId: 'org-1',
        userId: 'user-2',
        role: 'admin'
      })
    ).resolves.toEqual({ status: 'forbidden' })
  })

  it('maps a 400 cannot_remove_self to an invalid result', async () => {
    configureCloudEnv()
    runOperationDirectly()
    removeOrcaCloudOrgMemberMock.mockRejectedValue(
      new OrcaCloudRequestError(400, 'cannot_remove_self')
    )

    await expect(
      removeOrcaProfileOrgMember(userDataPath, { orgId: 'org-1', userId: 'user-1' })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_remove_self' })
  })

  it('maps a 404 revoke to not-found', async () => {
    configureCloudEnv()
    runOperationDirectly()
    revokeOrcaCloudOrgInviteMock.mockRejectedValue(new OrcaCloudRequestError(404))

    await expect(
      revokeOrcaProfileOrgInvite(userDataPath, { orgId: 'org-1', email: 'gone@b.com' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('reports reconnect-required when the session layer cannot refresh', async () => {
    configureCloudEnv()
    runWithFreshOrcaCloudSessionMock.mockResolvedValue({ status: 'reconnect-required' })

    await expect(listOrcaProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'reconnect-required'
    })
  })
})

describe('Orca cloud org members service (dev auth)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-org-members-dev-'))
    runWithFreshOrcaCloudSessionMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCA_CLOUD_DEV_AUTH', '1')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('serves an in-memory roster the caller can manage', async () => {
    const result = await listOrcaProfileOrgMembers(userDataPath, 'dev-list-org')
    if (result.status !== 'ok') {
      throw new Error(`Expected ok, got ${result.status}`)
    }
    expect(result.roster.canManageMembers).toBe(true)
    expect(result.roster.viewerRole).toBe('owner')
    expect(result.roster.members[0]).toMatchObject({ role: 'owner' })
    expect(result.roster.members.some((member) => member.userId === null)).toBe(true)
    expect(result.roster.pendingInvites.length).toBeGreaterThan(0)
    expect(runWithFreshOrcaCloudSessionMock).not.toHaveBeenCalled()
  })

  it('mutates the dev roster across invite and revoke', async () => {
    const orgId = 'dev-mutate-org'
    await expect(
      inviteOrcaProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@orca.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'ok' })

    const afterInvite = await listOrcaProfileOrgMembers(userDataPath, orgId)
    if (afterInvite.status !== 'ok') {
      throw new Error('expected ok')
    }
    expect(afterInvite.roster.pendingInvites.some((i) => i.email === 'fresh@orca.local')).toBe(true)

    await expect(
      inviteOrcaProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@orca.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_invited' })

    await expect(
      revokeOrcaProfileOrgInvite(userDataPath, { orgId, email: 'fresh@orca.local' })
    ).resolves.toEqual({ status: 'ok' })
    await expect(
      revokeOrcaProfileOrgInvite(userDataPath, { orgId, email: 'fresh@orca.local' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('blocks changing the dev owner (self) role', async () => {
    const orgId = 'dev-self-org'
    const list = await listOrcaProfileOrgMembers(userDataPath, orgId)
    if (list.status !== 'ok') {
      throw new Error('expected ok')
    }
    const self = list.roster.members.find((member) => member.role === 'owner')
    await expect(
      changeOrcaProfileOrgMemberRole(userDataPath, {
        orgId,
        userId: self?.userId ?? 'dev-user',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_change_own_role' })
  })
})
