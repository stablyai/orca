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
  revokeMCodeCloudSessionMock,
  selectMCodeCloudOrgMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginMCodeCloudPkceFlowMock: vi.fn(),
  createMCodeCloudProfileMock: vi.fn(),
  exchangeMCodeCloudAuthCodeMock: vi.fn(),
  revokeMCodeCloudSessionMock: vi.fn(),
  selectMCodeCloudOrgMock: vi.fn(),
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
  createMCodeCloudProfile: createMCodeCloudProfileMock,
  exchangeMCodeCloudAuthCode: exchangeMCodeCloudAuthCodeMock,
  revokeMCodeCloudSession: revokeMCodeCloudSessionMock,
  selectMCodeCloudOrg: selectMCodeCloudOrgMock
}))

import {
  connectCurrentMCodeProfile,
  createCloudLinkedMCodeProfile,
  getCurrentMCodeProfileAuthStatus,
  selectCurrentMCodeProfileOrg,
  signOutCurrentMCodeProfile
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

function configureCloudEnv(): void {
  vi.stubEnv('MCODE_CLOUD_API_URL', 'https://mcode-cloud.example')
  vi.stubEnv('MCODE_CLOUD_CLIENT_ID', 'desktop-client')
}

function futureExpiresAt(): number {
  return Date.now() + 3_600_000
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

describe('MCode cloud profile service', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'mcode-cloud-service-'))
    beginMCodeCloudPkceFlowMock.mockReset()
    createMCodeCloudProfileMock.mockReset()
    exchangeMCodeCloudAuthCodeMock.mockReset()
    revokeMCodeCloudSessionMock.mockReset()
    selectMCodeCloudOrgMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    revokeMCodeCloudSessionMock.mockResolvedValue(undefined)
    vi.unstubAllEnvs()
    vi.stubEnv('MCODE_CLOUD_API_URL', '')
    vi.stubEnv('MCODE_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('reports local unconfigured auth without cloud setup', () => {
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      activeProfileId: 'local-default',
      configured: false,
      state: 'unconfigured',
      persistence: 'none'
    })
  })

  it('connects the active local profile without replacing its local profile ID', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()

    const result = await connectCurrentMCodeProfile(userDataPath)

    if (result.status !== 'connected') {
      throw new Error(`Expected connected result, got ${result.status}`)
    }
    expect(result.activeProfileId).toBe('local-default')
    expect(result.profiles[0]).toMatchObject({
      id: 'local-default',
      kind: 'cloud-linked',
      cloud: cloudSummary
    })
    expect(exchangeMCodeCloudAuthCodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ localProfileId: 'local-default', nonce: 'nonce' })
    )
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'connected',
      persistence: 'encrypted',
      cloud: cloudSummary,
      organizations,
      capabilities
    })
  })

  it('treats provider-denied sign-in as a cancelled connect attempt', async () => {
    configureCloudEnv()
    beginMCodeCloudPkceFlowMock.mockRejectedValue(new Error('mcode_cloud_auth_denied'))

    const result = await connectCurrentMCodeProfile(userDataPath)

    expect(result.status).toBe('cancelled')
    expect(exchangeMCodeCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'local',
      persistence: 'none'
    })
  })

  it('does not report a saved cloud session as connected when cloud config is unavailable', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentMCodeProfile(userDataPath)
    vi.stubEnv('MCODE_CLOUD_API_URL', '')
    vi.stubEnv('MCODE_CLOUD_CLIENT_ID', '')

    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      configured: false,
      state: 'unconfigured',
      persistence: 'encrypted',
      cloud: cloudSummary,
      setupMessage: 'MCode Cloud sign-in is not configured for this build.'
    })
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).organizations).toBeUndefined()
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).capabilities).toBeUndefined()
  })

  it('signs out by removing cloud metadata while keeping the local profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentMCodeProfile(userDataPath)

    const result = await signOutCurrentMCodeProfile(userDataPath)

    expect(result.status).toBe('signed-out')
    expect(result.activeProfileId).toBe('local-default')
    expect(result.profiles[0]).toMatchObject({ id: 'local-default', kind: 'local' })
    expect(result.profiles[0]?.cloud).toBeUndefined()
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'local',
      persistence: 'none'
    })
    expect(revokeMCodeCloudSessionMock).toHaveBeenCalledOnce()
  })

  it('creates a new empty cloud-linked profile with its own cloud session', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentMCodeProfile(userDataPath)
    createMCodeCloudProfileMock.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresAt: 1000,
      cloud: {
        ...cloudSummary,
        cloudProfileId: 'cloud-profile-2',
        activeOrgId: 'org-1',
        activeOrgName: 'Acme'
      },
      organizations,
      capabilities: { flags: { share: true, team: true }, refreshedAt: 13 }
    } satisfies MCodeCloudSessionExchangeResponse)

    const result = await createCloudLinkedMCodeProfile(userDataPath, {
      orgId: 'org-1',
      name: 'Acme'
    })

    if (result.status !== 'created') {
      throw new Error(`Expected created result, got ${result.status}`)
    }
    expect(result.profile).toMatchObject({
      id: expect.stringMatching(/^cloud-/),
      name: 'Acme',
      kind: 'cloud-linked',
      cloud: expect.objectContaining({ cloudProfileId: 'cloud-profile-2' })
    })
    expect(createMCodeCloudProfileMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' }),
      { orgId: 'org-1', name: 'Acme' }
    )
  })

  it('selects an organization for a connected profile', async () => {
    configureCloudEnv()
    mockSuccessfulConnect()
    await connectCurrentMCodeProfile(userDataPath)
    const orgCloudSummary = {
      ...cloudSummary,
      activeOrgId: 'org-1',
      activeOrgName: 'Acme'
    }
    selectMCodeCloudOrgMock.mockResolvedValue({
      cloud: orgCloudSummary,
      organizations,
      capabilities: { flags: { share: true, sso: true }, refreshedAt: 12 }
    })

    const result = await selectCurrentMCodeProfileOrg(userDataPath, 'org-1')

    expect(result.status).toBe('selected')
    expect(selectMCodeCloudOrgMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ accessToken: 'access-token' }),
      'org-1'
    )
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).cloud).toMatchObject({
      activeOrgId: 'org-1',
      activeOrgName: 'Acme'
    })
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).organizations).toEqual(organizations)
  })
})
