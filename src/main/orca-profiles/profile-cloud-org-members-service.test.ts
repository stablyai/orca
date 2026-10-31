import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  removeOrcaProfileOrgMember,
  revokeOrcaProfileOrgInvite
} from './profile-cloud-org-members-service'

const fakeSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 3_600_000,
  capabilities: { flags: {}, refreshedAt: 1 }
}

// Business 4xx return as values, so the session layer sees only thrown auth failures.
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
})
