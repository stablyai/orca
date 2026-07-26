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
  OrcaCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginOrcaCloudPkceFlowMock: vi.fn(),
  createOrcaCloudProfileMock: vi.fn(),
  exchangeOrcaCloudAuthCodeMock: vi.fn(),
  refreshOrcaCloudCapabilitiesMock: vi.fn(),
  refreshOrcaCloudSessionMock: vi.fn(),
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
  selectOrcaCloudOrg: vi.fn()
}))

import {
  connectCurrentOrcaProfile,
  createCloudLinkedOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  refreshCurrentOrcaProfileAuth
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

function mockSuccessfulConnect(expiresAt = futureExpiresAt()): void {
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
    expiresAt,
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies OrcaCloudSessionExchangeResponse)
}

describe('Orca cloud profile service session refresh', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-service-refresh-'))
    beginOrcaCloudPkceFlowMock.mockReset()
    createOrcaCloudProfileMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    refreshOrcaCloudCapabilitiesMock.mockReset()
    refreshOrcaCloudSessionMock.mockReset()
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

  it('refreshes an expired access token before creating cloud profiles', async () => {
    configureCloudEnv()
    mockSuccessfulConnect(Date.now() - 1_000)
    await connectCurrentOrcaProfile(userDataPath)
    refreshOrcaCloudSessionMock.mockResolvedValue({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: cloudSummary,
      organizations,
      capabilities
    } satisfies OrcaCloudSessionExchangeResponse)
    createOrcaCloudProfileMock.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: {
        ...cloudSummary,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      },
      organizations,
      capabilities
    } satisfies OrcaCloudSessionExchangeResponse)

    const result = await createCloudLinkedOrcaProfile(userDataPath, {
      orgId: 'org-1',
      name: 'Acme'
    })

    expect(result.status).toBe('created')
    expect(refreshOrcaCloudSessionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ refreshToken: 'refresh-token' })
    )
    expect(createOrcaCloudProfileMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      { orgId: 'org-1', name: 'Acme' }
    )
  })

  it('refreshes capability flags for the connected profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentOrcaProfile(userDataPath)
    refreshOrcaCloudCapabilitiesMock.mockResolvedValue({
      capabilities: {
        flags: { share: false, team: true },
        refreshedAt: 25
      }
    })

    const result = await refreshCurrentOrcaProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshOrcaCloudCapabilitiesMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' })
    )
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false, team: true },
      refreshedAt: 25
    })
  })

  it('clears stale active org metadata when capability refresh returns no active org', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    exchangeOrcaCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
      organizations,
      capabilities
    } satisfies OrcaCloudSessionExchangeResponse)
    await connectCurrentOrcaProfile(userDataPath)
    refreshOrcaCloudCapabilitiesMock.mockResolvedValue({
      cloud: cloudSummary,
      organizations: [],
      capabilities: {
        flags: { share: false },
        refreshedAt: 31
      }
    })

    const result = await refreshCurrentOrcaProfileAuth(userDataPath)
    const status = getCurrentOrcaProfileAuthStatus(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(status.cloud?.activeOrgId).toBeUndefined()
    expect(status.cloud?.activeOrgName).toBeUndefined()
    expect(status.organizations).toEqual([])
    expect(status.capabilities).toEqual({
      flags: { share: false },
      refreshedAt: 31
    })
  })

  it('requires reconnect when an expired refresh token is rejected', async () => {
    configureCloudEnv()
    mockSuccessfulConnect(Date.now() - 1_000)
    await connectCurrentOrcaProfile(userDataPath)
    refreshOrcaCloudSessionMock.mockRejectedValue(new OrcaCloudRequestErrorMock(401))

    const result = await refreshCurrentOrcaProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })
})
