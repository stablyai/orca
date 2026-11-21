import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary
} from '../../../shared/orca-profiles/orca-profiles'

const {
  createOrcaCloudProfileMock,
  beginOrcaCloudPkceFlowMock,
  exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSessionMock,
  safeStorageMock
} = vi.hoisted(() => ({
  createOrcaCloudProfileMock: vi.fn(),
  beginOrcaCloudPkceFlowMock: vi.fn(),
  exchangeOrcaCloudAuthCodeMock: vi.fn(),
  revokeOrcaCloudSessionMock: vi.fn(),
  safeStorageMock: {
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
    isEncryptionAvailable: vi.fn(() => true)
  }
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  createOrcaCloudProfile: createOrcaCloudProfileMock,
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSession: revokeOrcaCloudSessionMock,
  selectOrcaCloudOrg: vi.fn()
}))

import {
  connectCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  signOutCurrentOrcaProfile
} from './profile-cloud-service'

import { OrcaAccountService } from '../orca-account-service'
import { loadOrCreateProfileIndex } from '../profile-index-store'

// The PKCE flow is mocked, so no browser opens.
const openNoBrowser = async (): Promise<void> => {}

const cloud: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

const laterCloud: OrcaProfileCloudSummary = {
  ...cloud,
  cloudProfileId: 'cloud-profile-2',
  email: 'ada@example.com'
}

const capabilities: OrcaCloudCapabilities = { flags: { share: true }, refreshedAt: 11 }
const organizations: OrcaCloudOrgSummary[] = [{ orgId: 'org-1', name: 'Acme', role: 'Admin' }]

describe('Orca cloud sign-out vs newer connect', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-sign-out-connect-'))
    createOrcaCloudProfileMock.mockReset()
    beginOrcaCloudPkceFlowMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    revokeOrcaCloudSessionMock.mockReset()
    revokeOrcaCloudSessionMock.mockResolvedValue(undefined)
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
    vi.stubEnv('ORCA_RELAY_URL', 'https://relay.example.test')
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
      expiresAt: Date.now() + 3_600_000,
      cloud,
      organizations,
      capabilities
    })
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('keeps a newer connect that finishes while sign-out is still revoking', async () => {
    await expect(connectCurrentOrcaProfile(userDataPath, openNoBrowser)).resolves.toMatchObject({
      status: 'connected'
    })
    let finishRevoke!: () => void
    revokeOrcaCloudSessionMock.mockReturnValue(
      new Promise<void>((resolve) => {
        finishRevoke = resolve
      })
    )
    const signingOut = signOutCurrentOrcaProfile(userDataPath)
    exchangeOrcaCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'later-access',
      refreshToken: 'later-refresh',
      expiresAt: Date.now() + 3_600_000,
      cloud: laterCloud,
      organizations,
      capabilities
    })
    await expect(connectCurrentOrcaProfile(userDataPath, openNoBrowser)).resolves.toMatchObject({
      status: 'connected'
    })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).cloud?.email).toBe('ada@example.com')
    finishRevoke()
    await expect(signingOut).resolves.toMatchObject({ status: 'signed-out' })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'connected',
      cloud: { email: 'ada@example.com' }
    })
  })

  it.each(['none', 'same-server', 'new-server'] as const)(
    'commits an in-flight profile only if its server stayed unchanged (switch=%s)',
    async (switchKind) => {
      const account = new OrcaAccountService({
        openBrowser: openNoBrowser,
        userDataPath: () => userDataPath
      })
      await expect(account.connect()).resolves.toMatchObject({ status: 'connected' })
      let finishCreate!: (value: unknown) => void
      let requestStarted!: () => void
      const started = new Promise<void>((resolve) => {
        requestStarted = resolve
      })
      createOrcaCloudProfileMock.mockImplementation(() => {
        requestStarted()
        return new Promise((resolve) => {
          finishCreate = resolve
        })
      })
      const creating = account.createCloudLinked({ name: 'Work' })
      await started
      if (switchKind === 'new-server') {
        await account.withCloudServerSwitch(async (serverChanging) => {
          serverChanging()
          await account.signOut()
          vi.stubEnv('ORCA_CLOUD_API_URL', 'https://new-auth.example.test')
        })
      } else if (switchKind === 'same-server') {
        await account.withCloudServerSwitch(async () => {})
      }
      finishCreate({
        accessToken: 'created-access',
        refreshToken: 'created-refresh',
        expiresAt: Date.parse('2100-01-01T00:00:00.000Z'),
        cloud: laterCloud,
        organizations,
        capabilities
      })
      if (switchKind === 'new-server') {
        await expect(creating).resolves.toMatchObject({
          status: 'reconnect-required'
        })
        expect(
          loadOrCreateProfileIndex(userDataPath).profiles.map((profile) => profile.id)
        ).toEqual(['local-default'])
        expect(readdirSync(join(userDataPath, 'profiles'))).toEqual(['local-default'])
      } else {
        await expect(creating).resolves.toMatchObject({
          status: 'created',
          profile: { name: 'Work', cloud: { cloudProfileId: 'cloud-profile-2' } }
        })
      }
    }
  )
})
