import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary
} from '../../shared/orca-profiles'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'

const {
  beginOrcaCloudPkceFlowMock,
  createOrcaCloudProfileMock,
  exchangeOrcaCloudAuthCodeMock,
  refreshOrcaCloudCapabilitiesMock,
  refreshOrcaCloudSessionMock,
  selectOrcaCloudOrgMock,
  OrcaCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginOrcaCloudPkceFlowMock: vi.fn(),
  createOrcaCloudProfileMock: vi.fn(),
  exchangeOrcaCloudAuthCodeMock: vi.fn(),
  refreshOrcaCloudCapabilitiesMock: vi.fn(),
  refreshOrcaCloudSessionMock: vi.fn(),
  selectOrcaCloudOrgMock: vi.fn(),
  OrcaCloudRequestErrorMock: class OrcaCloudRequestError extends Error {
    constructor(public readonly statusCode: number) {
      super(`orca_cloud_request_failed_${statusCode}`)
      this.name = 'OrcaCloudRequestError'
    }
  },
  safeStorageMock: {
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
    isEncryptionAvailable: vi.fn(() => true)
  }
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  OrcaCloudRequestError: OrcaCloudRequestErrorMock,
  createOrcaCloudProfile: createOrcaCloudProfileMock,
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  refreshOrcaCloudCapabilities: refreshOrcaCloudCapabilitiesMock,
  refreshOrcaCloudSession: refreshOrcaCloudSessionMock,
  revokeOrcaCloudSession: vi.fn(),
  selectOrcaCloudOrg: selectOrcaCloudOrgMock
}))

import {
  connectCurrentOrcaProfile,
  createCloudLinkedOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  refreshCurrentOrcaProfileAuth,
  selectCurrentOrcaProfileOrg
} from './profile-cloud-service'

const cloudSummary: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

const capabilities: OrcaCloudCapabilities = {
  flags: { share: true },
  refreshedAt: 11
}

const organizations: OrcaCloudOrgSummary[] = [
  { orgId: 'org-1', name: 'Acme', role: 'Admin' },
  { orgId: 'org-2', name: 'Personal' }
]

function futureExpiresAt(): number {
  return Date.now() + 3_600_000
}

function configureCloudEnv(): void {
  vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
  vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
}

function mockSuccessfulConnect(): void {
  beginOrcaCloudPkceFlowMock.mockResolvedValue({
    code: 'auth-code',
    codeVerifier: 'code-verifier',
    nonce: 'nonce',
    redirectUri: 'http://127.0.0.1:4100/auth/callback',
    state: 'state'
  })
  exchangeOrcaCloudAuthCodeMock.mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies OrcaCloudSessionExchangeResponse)
}

function mockSuccessfulSessionRefresh(): void {
  refreshOrcaCloudSessionMock.mockResolvedValue({
    accessToken: 'rotated-access-token',
    refreshToken: 'rotated-refresh-token',
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies OrcaCloudSessionExchangeResponse)
}

describe('Orca cloud profile auth-failure retry', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-service-auth-retry-'))
    beginOrcaCloudPkceFlowMock.mockReset()
    createOrcaCloudProfileMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    refreshOrcaCloudCapabilitiesMock.mockReset()
    refreshOrcaCloudSessionMock.mockReset()
    selectOrcaCloudOrgMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('ORCA_CLOUD_API_URL', '')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('refreshes and retries cloud profile creation after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentOrcaProfile(userDataPath)
    createOrcaCloudProfileMock
      .mockRejectedValueOnce(new OrcaCloudRequestErrorMock(401))
      .mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: futureExpiresAt(),
        cloud: { ...cloudSummary, cloudProfileId: 'cloud-profile-2' },
        organizations,
        capabilities
      } satisfies OrcaCloudSessionExchangeResponse)

    const result = await createCloudLinkedOrcaProfile(userDataPath, { name: 'Acme' })

    expect(result.status).toBe('created')
    expect(createOrcaCloudProfileMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      { name: 'Acme' }
    )
  })

  it('refreshes and retries capability refresh after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentOrcaProfile(userDataPath)
    refreshOrcaCloudCapabilitiesMock
      .mockRejectedValueOnce(new OrcaCloudRequestErrorMock(403))
      .mockResolvedValue({
        capabilities: { flags: { share: false }, refreshedAt: 26 } satisfies OrcaCloudCapabilities
      })

    const result = await refreshCurrentOrcaProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshOrcaCloudCapabilitiesMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' })
    )
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false },
      refreshedAt: 26
    })
  })

  it('requires reconnect when a retried capability refresh is still unauthorized', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentOrcaProfile(userDataPath)
    refreshOrcaCloudCapabilitiesMock
      .mockRejectedValueOnce(new OrcaCloudRequestErrorMock(401))
      .mockRejectedValueOnce(new OrcaCloudRequestErrorMock(401))

    const result = await refreshCurrentOrcaProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })

  it('refreshes and retries organization selection after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentOrcaProfile(userDataPath)
    selectOrcaCloudOrgMock
      .mockRejectedValueOnce(new OrcaCloudRequestErrorMock(401))
      .mockResolvedValue({
        cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
        organizations,
        capabilities
      })

    const result = await selectCurrentOrcaProfileOrg(userDataPath, 'org-1')

    expect(result.status).toBe('selected')
    expect(selectOrcaCloudOrgMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      'org-1'
    )
  })
})
