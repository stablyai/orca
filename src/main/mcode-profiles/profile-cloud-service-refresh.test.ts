import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MCodeCloudCapabilities,
  MCodeCloudOrgSummary,
  MCodeProfileCloudSummary
} from '../../shared/mcode-profiles'
import type { MCodeCloudSessionExchangeResponse } from './profile-cloud-session-exchange'

const {
  beginMCodeCloudPkceFlowMock,
  createMCodeCloudProfileMock,
  exchangeMCodeCloudAuthCodeMock,
  refreshMCodeCloudCapabilitiesMock,
  refreshMCodeCloudSessionMock,
  MCodeCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginMCodeCloudPkceFlowMock: vi.fn(),
  createMCodeCloudProfileMock: vi.fn(),
  exchangeMCodeCloudAuthCodeMock: vi.fn(),
  refreshMCodeCloudCapabilitiesMock: vi.fn(),
  refreshMCodeCloudSessionMock: vi.fn(),
  MCodeCloudRequestErrorMock: class MCodeCloudRequestError extends Error {
    constructor(public readonly statusCode: number) {
      super(`mcode_cloud_request_failed_${statusCode}`)
      this.name = 'MCodeCloudRequestError'
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
  beginMCodeCloudPkceFlow: beginMCodeCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  MCodeCloudRequestError: MCodeCloudRequestErrorMock,
  createMCodeCloudProfile: createMCodeCloudProfileMock,
  exchangeMCodeCloudAuthCode: exchangeMCodeCloudAuthCodeMock,
  refreshMCodeCloudCapabilities: refreshMCodeCloudCapabilitiesMock,
  refreshMCodeCloudSession: refreshMCodeCloudSessionMock,
  revokeMCodeCloudSession: vi.fn(),
  selectMCodeCloudOrg: vi.fn()
}))

import {
  connectCurrentMCodeProfile,
  createCloudLinkedMCodeProfile,
  getCurrentMCodeProfileAuthStatus,
  refreshCurrentMCodeProfileAuth
} from './profile-cloud-service'

const cloudSummary: MCodeProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

const capabilities: MCodeCloudCapabilities = {
  flags: { share: true },
  refreshedAt: 11
}

const organizations: MCodeCloudOrgSummary[] = [
  { orgId: 'org-1', name: 'Acme', role: 'Admin' },
  { orgId: 'org-2', name: 'Personal' }
]

function futureExpiresAt(): number {
  return Date.now() + 3_600_000
}

function configureCloudEnv(): void {
  vi.stubEnv('MCODE_CLOUD_API_URL', 'https://mcode-cloud.example')
  vi.stubEnv('MCODE_CLOUD_CLIENT_ID', 'desktop-client')
}

function mockSuccessfulConnect(expiresAt = futureExpiresAt()): void {
  beginMCodeCloudPkceFlowMock.mockResolvedValue({
    code: 'auth-code',
    codeVerifier: 'code-verifier',
    nonce: 'nonce',
    redirectUri: 'http://127.0.0.1:4100/auth/callback',
    state: 'state'
  })
  exchangeMCodeCloudAuthCodeMock.mockResolvedValue({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt,
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies MCodeCloudSessionExchangeResponse)
}

describe('MCode cloud profile service session refresh', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'mcode-cloud-service-refresh-'))
    beginMCodeCloudPkceFlowMock.mockReset()
    createMCodeCloudProfileMock.mockReset()
    exchangeMCodeCloudAuthCodeMock.mockReset()
    refreshMCodeCloudCapabilitiesMock.mockReset()
    refreshMCodeCloudSessionMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('MCODE_CLOUD_API_URL', '')
    vi.stubEnv('MCODE_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('refreshes an expired access token before creating cloud profiles', async () => {
    configureCloudEnv()
    mockSuccessfulConnect(Date.now() - 1_000)
    await connectCurrentMCodeProfile(userDataPath)
    refreshMCodeCloudSessionMock.mockResolvedValue({
      accessToken: 'rotated-access-token',
      refreshToken: 'rotated-refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: cloudSummary,
      organizations,
      capabilities
    } satisfies MCodeCloudSessionExchangeResponse)
    createMCodeCloudProfileMock.mockResolvedValue({
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
    } satisfies MCodeCloudSessionExchangeResponse)

    const result = await createCloudLinkedMCodeProfile(userDataPath, {
      orgId: 'org-1',
      name: 'Acme'
    })

    expect(result.status).toBe('created')
    expect(refreshMCodeCloudSessionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ refreshToken: 'refresh-token' })
    )
    expect(createMCodeCloudProfileMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      { orgId: 'org-1', name: 'Acme' }
    )
  })

  it('refreshes capability flags for the connected profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentMCodeProfile(userDataPath)
    refreshMCodeCloudCapabilitiesMock.mockResolvedValue({
      capabilities: {
        flags: { share: false, team: true },
        refreshedAt: 25
      }
    })

    const result = await refreshCurrentMCodeProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshMCodeCloudCapabilitiesMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' })
    )
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false, team: true },
      refreshedAt: 25
    })
  })

  it('clears stale active org metadata when capability refresh returns no active org', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    exchangeMCodeCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: futureExpiresAt(),
      cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
      organizations,
      capabilities
    } satisfies MCodeCloudSessionExchangeResponse)
    await connectCurrentMCodeProfile(userDataPath)
    refreshMCodeCloudCapabilitiesMock.mockResolvedValue({
      cloud: cloudSummary,
      organizations: [],
      capabilities: {
        flags: { share: false },
        refreshedAt: 31
      }
    })

    const result = await refreshCurrentMCodeProfileAuth(userDataPath)
    const status = getCurrentMCodeProfileAuthStatus(userDataPath)

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
    await connectCurrentMCodeProfile(userDataPath)
    refreshMCodeCloudSessionMock.mockRejectedValue(new MCodeCloudRequestErrorMock(401))

    const result = await refreshCurrentMCodeProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })
})
