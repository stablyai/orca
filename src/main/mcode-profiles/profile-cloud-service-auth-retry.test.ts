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
  selectMCodeCloudOrgMock,
  MCodeCloudRequestErrorMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginMCodeCloudPkceFlowMock: vi.fn(),
  createMCodeCloudProfileMock: vi.fn(),
  exchangeMCodeCloudAuthCodeMock: vi.fn(),
  refreshMCodeCloudCapabilitiesMock: vi.fn(),
  refreshMCodeCloudSessionMock: vi.fn(),
  selectMCodeCloudOrgMock: vi.fn(),
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
  selectMCodeCloudOrg: selectMCodeCloudOrgMock
}))

import {
  connectCurrentMCodeProfile,
  createCloudLinkedMCodeProfile,
  getCurrentMCodeProfileAuthStatus,
  refreshCurrentMCodeProfileAuth,
  selectCurrentMCodeProfileOrg
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

function mockSuccessfulConnect(): void {
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
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies MCodeCloudSessionExchangeResponse)
}

function mockSuccessfulSessionRefresh(): void {
  refreshMCodeCloudSessionMock.mockResolvedValue({
    accessToken: 'rotated-access-token',
    refreshToken: 'rotated-refresh-token',
    expiresAt: futureExpiresAt(),
    cloud: cloudSummary,
    organizations,
    capabilities
  } satisfies MCodeCloudSessionExchangeResponse)
}

describe('MCode cloud profile auth-failure retry', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'mcode-cloud-service-auth-retry-'))
    beginMCodeCloudPkceFlowMock.mockReset()
    createMCodeCloudProfileMock.mockReset()
    exchangeMCodeCloudAuthCodeMock.mockReset()
    refreshMCodeCloudCapabilitiesMock.mockReset()
    refreshMCodeCloudSessionMock.mockReset()
    selectMCodeCloudOrgMock.mockReset()
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

  it('refreshes and retries cloud profile creation after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentMCodeProfile(userDataPath)
    createMCodeCloudProfileMock
      .mockRejectedValueOnce(new MCodeCloudRequestErrorMock(401))
      .mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: futureExpiresAt(),
        cloud: { ...cloudSummary, cloudProfileId: 'cloud-profile-2' },
        organizations,
        capabilities
      } satisfies MCodeCloudSessionExchangeResponse)

    const result = await createCloudLinkedMCodeProfile(userDataPath, { name: 'Acme' })

    expect(result.status).toBe('created')
    expect(createMCodeCloudProfileMock).toHaveBeenNthCalledWith(
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
    await connectCurrentMCodeProfile(userDataPath)
    refreshMCodeCloudCapabilitiesMock
      .mockRejectedValueOnce(new MCodeCloudRequestErrorMock(403))
      .mockResolvedValue({
        capabilities: { flags: { share: false }, refreshedAt: 26 } satisfies MCodeCloudCapabilities
      })

    const result = await refreshCurrentMCodeProfileAuth(userDataPath)

    expect(result.status).toBe('refreshed')
    expect(refreshMCodeCloudCapabilitiesMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' })
    )
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).capabilities).toEqual({
      flags: { share: false },
      refreshedAt: 26
    })
  })

  it('requires reconnect when a retried capability refresh is still unauthorized', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentMCodeProfile(userDataPath)
    refreshMCodeCloudCapabilitiesMock
      .mockRejectedValueOnce(new MCodeCloudRequestErrorMock(401))
      .mockRejectedValueOnce(new MCodeCloudRequestErrorMock(401))

    const result = await refreshCurrentMCodeProfileAuth(userDataPath)

    expect(result.status).toBe('reconnect-required')
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'reconnect-required',
      persistence: 'none',
      cloud: cloudSummary
    })
  })

  it('refreshes and retries organization selection after an auth failure', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    mockSuccessfulSessionRefresh()
    await connectCurrentMCodeProfile(userDataPath)
    selectMCodeCloudOrgMock
      .mockRejectedValueOnce(new MCodeCloudRequestErrorMock(401))
      .mockResolvedValue({
        cloud: { ...cloudSummary, activeOrgId: 'org-1', activeOrgName: 'Acme' },
        organizations,
        capabilities
      })

    const result = await selectCurrentMCodeProfileOrg(userDataPath, 'org-1')

    expect(result.status).toBe('selected')
    expect(selectMCodeCloudOrgMock).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.objectContaining({ accessToken: 'rotated-access-token' }),
      'org-1'
    )
  })
})
