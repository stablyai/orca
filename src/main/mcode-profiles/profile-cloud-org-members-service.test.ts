import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MCodeOrgMembersRoster } from '../../shared/mcode-profiles'
import { MCodeCloudRequestError } from './profile-cloud-client'

const {
  runWithFreshMCodeCloudSessionMock,
  listMCodeCloudOrgMembersMock,
  inviteMCodeCloudOrgMemberMock,
  revokeMCodeCloudOrgInviteMock,
  changeMCodeCloudOrgMemberRoleMock,
  removeMCodeCloudOrgMemberMock
} = vi.hoisted(() => ({
  runWithFreshMCodeCloudSessionMock: vi.fn(),
  listMCodeCloudOrgMembersMock: vi.fn(),
  inviteMCodeCloudOrgMemberMock: vi.fn(),
  revokeMCodeCloudOrgInviteMock: vi.fn(),
  changeMCodeCloudOrgMemberRoleMock: vi.fn(),
  removeMCodeCloudOrgMemberMock: vi.fn()
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

vi.mock('./profile-cloud-session-refresh', () => ({
  runWithFreshMCodeCloudSessionMock,
  runWithFreshMCodeCloudSession: runWithFreshMCodeCloudSessionMock
}))

vi.mock('./profile-cloud-org-members-client', () => ({
  listMCodeCloudOrgMembers: listMCodeCloudOrgMembersMock,
  inviteMCodeCloudOrgMember: inviteMCodeCloudOrgMemberMock,
  revokeMCodeCloudOrgInvite: revokeMCodeCloudOrgInviteMock,
  changeMCodeCloudOrgMemberRole: changeMCodeCloudOrgMemberRoleMock,
  removeMCodeCloudOrgMember: removeMCodeCloudOrgMemberMock
}))

import {
  changeMCodeProfileOrgMemberRole,
  inviteMCodeProfileOrgMember,
  listMCodeProfileOrgMembers,
  removeMCodeProfileOrgMember,
  revokeMCodeProfileOrgInvite
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
  runWithFreshMCodeCloudSessionMock.mockImplementation(
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
  vi.stubEnv('MCODE_CLOUD_API_URL', 'https://mcode-cloud.example')
  vi.stubEnv('MCODE_CLOUD_CLIENT_ID', 'desktop-client')
}

const roster: MCodeOrgMembersRoster = {
  members: [{ userId: 'user-1', email: 'nina@example.com', role: 'owner' }],
  pendingInvites: [],
  viewerRole: 'owner',
  canManageMembers: true
}

describe('MCode cloud org members service (configured)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'mcode-org-members-'))
    runWithFreshMCodeCloudSessionMock.mockReset()
    listMCodeCloudOrgMembersMock.mockReset()
    inviteMCodeCloudOrgMemberMock.mockReset()
    revokeMCodeCloudOrgInviteMock.mockReset()
    changeMCodeCloudOrgMemberRoleMock.mockReset()
    removeMCodeCloudOrgMemberMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('MCODE_CLOUD_DEV_AUTH', '')
    vi.stubEnv('MCODE_CLOUD_API_URL', '')
    vi.stubEnv('MCODE_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('reports unconfigured when cloud sign-in is not set up', async () => {
    await expect(listMCodeProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'unconfigured'
    })
    expect(runWithFreshMCodeCloudSessionMock).not.toHaveBeenCalled()
  })

  it('returns the roster from the client', async () => {
    configureCloudEnv()
    runOperationDirectly()
    listMCodeCloudOrgMembersMock.mockResolvedValue(roster)

    await expect(listMCodeProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'ok',
      roster
    })
    expect(listMCodeCloudOrgMembersMock).toHaveBeenCalledWith(
      expect.any(Object),
      fakeSession,
      'org-1'
    )
  })

  it('maps a 409 already_member invite conflict', async () => {
    configureCloudEnv()
    runOperationDirectly()
    inviteMCodeCloudOrgMemberMock.mockRejectedValue(new MCodeCloudRequestError(409, 'already_member'))

    await expect(
      inviteMCodeProfileOrgMember(userDataPath, { orgId: 'org-1', email: 'a@b.com', role: 'member' })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_member' })
  })

  it('maps a 403 role change to forbidden', async () => {
    configureCloudEnv()
    runOperationDirectly()
    changeMCodeCloudOrgMemberRoleMock.mockRejectedValue(new MCodeCloudRequestError(403))

    await expect(
      changeMCodeProfileOrgMemberRole(userDataPath, {
        orgId: 'org-1',
        userId: 'user-2',
        role: 'admin'
      })
    ).resolves.toEqual({ status: 'forbidden' })
  })

  it('maps a 400 cannot_remove_self to an invalid result', async () => {
    configureCloudEnv()
    runOperationDirectly()
    removeMCodeCloudOrgMemberMock.mockRejectedValue(
      new MCodeCloudRequestError(400, 'cannot_remove_self')
    )

    await expect(
      removeMCodeProfileOrgMember(userDataPath, { orgId: 'org-1', userId: 'user-1' })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_remove_self' })
  })

  it('maps a 404 revoke to not-found', async () => {
    configureCloudEnv()
    runOperationDirectly()
    revokeMCodeCloudOrgInviteMock.mockRejectedValue(new MCodeCloudRequestError(404))

    await expect(
      revokeMCodeProfileOrgInvite(userDataPath, { orgId: 'org-1', email: 'gone@b.com' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('reports reconnect-required when the session layer cannot refresh', async () => {
    configureCloudEnv()
    runWithFreshMCodeCloudSessionMock.mockResolvedValue({ status: 'reconnect-required' })

    await expect(listMCodeProfileOrgMembers(userDataPath, 'org-1')).resolves.toEqual({
      status: 'reconnect-required'
    })
  })
})

describe('MCode cloud org members service (dev auth)', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'mcode-org-members-dev-'))
    runWithFreshMCodeCloudSessionMock.mockReset()
    vi.unstubAllEnvs()
    vi.stubEnv('MCODE_CLOUD_DEV_AUTH', '1')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('serves an in-memory roster the caller can manage', async () => {
    const result = await listMCodeProfileOrgMembers(userDataPath, 'dev-list-org')
    if (result.status !== 'ok') {
      throw new Error(`Expected ok, got ${result.status}`)
    }
    expect(result.roster.canManageMembers).toBe(true)
    expect(result.roster.viewerRole).toBe('owner')
    expect(result.roster.members[0]).toMatchObject({ role: 'owner' })
    expect(result.roster.members.some((member) => member.userId === null)).toBe(true)
    expect(result.roster.pendingInvites.length).toBeGreaterThan(0)
    expect(runWithFreshMCodeCloudSessionMock).not.toHaveBeenCalled()
  })

  it('mutates the dev roster across invite and revoke', async () => {
    const orgId = 'dev-mutate-org'
    await expect(
      inviteMCodeProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@mcode.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'ok' })

    const afterInvite = await listMCodeProfileOrgMembers(userDataPath, orgId)
    if (afterInvite.status !== 'ok') {
      throw new Error('expected ok')
    }
    expect(afterInvite.roster.pendingInvites.some((i) => i.email === 'fresh@mcode.local')).toBe(true)

    await expect(
      inviteMCodeProfileOrgMember(userDataPath, {
        orgId,
        email: 'fresh@mcode.local',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'conflict', reason: 'already_invited' })

    await expect(
      revokeMCodeProfileOrgInvite(userDataPath, { orgId, email: 'fresh@mcode.local' })
    ).resolves.toEqual({ status: 'ok' })
    await expect(
      revokeMCodeProfileOrgInvite(userDataPath, { orgId, email: 'fresh@mcode.local' })
    ).resolves.toEqual({ status: 'not-found' })
  })

  it('blocks changing the dev owner (self) role', async () => {
    const orgId = 'dev-self-org'
    const list = await listMCodeProfileOrgMembers(userDataPath, orgId)
    if (list.status !== 'ok') {
      throw new Error('expected ok')
    }
    const self = list.roster.members.find((member) => member.role === 'owner')
    await expect(
      changeMCodeProfileOrgMemberRole(userDataPath, {
        orgId,
        userId: self?.userId ?? 'dev-user',
        role: 'member'
      })
    ).resolves.toEqual({ status: 'invalid', reason: 'cannot_change_own_role' })
  })
})
