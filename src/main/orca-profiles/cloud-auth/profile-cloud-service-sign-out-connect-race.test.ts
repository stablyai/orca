import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as profileIndex from '../profile-index-store-async'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary
} from '../../../shared/orca-profiles/orca-profiles'

const {
  beginOrcaCloudPkceFlowMock,
  exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSessionMock,
  safeStorageMock
} = vi.hoisted(() => ({
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
  createOrcaCloudProfile: vi.fn(),
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSession: revokeOrcaCloudSessionMock,
  selectOrcaCloudOrg: vi.fn()
}))

import {
  connectCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  signOutCurrentOrcaProfile
} from './profile-cloud-service'

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
    beginOrcaCloudPkceFlowMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    revokeOrcaCloudSessionMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.stubEnv('ORCA_CLOUD_API_URL', 'https://orca-cloud.example')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
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
      expiresAt: 9_999_999_999_999,
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
    const revoking = Promise.withResolvers<void>()
    let finishRevoke!: () => void
    revokeOrcaCloudSessionMock.mockResolvedValue(undefined).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRevoke = resolve
          revoking.resolve()
        })
    )
    const signingOut = signOutCurrentOrcaProfile(userDataPath)
    await revoking.promise
    exchangeOrcaCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'later-access',
      refreshToken: 'later-refresh',
      expiresAt: 9_999_999_999_999,
      cloud: laterCloud,
      organizations,
      capabilities
    })
    await expect(connectCurrentOrcaProfile(userDataPath, openNoBrowser)).resolves.toMatchObject({
      status: 'connected'
    })
    expect((await getCurrentOrcaProfileAuthStatus(userDataPath)).cloud?.email).toBe(
      'ada@example.com'
    )
    finishRevoke()
    await expect(signingOut).resolves.toMatchObject({ status: 'signed-out' })
    expect(await getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'connected',
      cloud: { email: 'ada@example.com' }
    })
  })
  it('never revokes a newer sign-in completed during the initial profile lookup', async () => {
    await connectCurrentOrcaProfile(userDataPath, openNoBrowser)
    const lookup = Promise.withResolvers<void>()
    const original = profileIndex.ensureActiveOrcaProfileAsync
    const spy = vi
      .spyOn(profileIndex, 'ensureActiveOrcaProfileAsync')
      .mockImplementationOnce(async (...args) => {
        await lookup.promise
        return original(...args)
      })
    revokeOrcaCloudSessionMock.mockResolvedValue(undefined)
    const signingOut = signOutCurrentOrcaProfile(userDataPath)
    exchangeOrcaCloudAuthCodeMock.mockResolvedValue({
      accessToken: 'later-access',
      refreshToken: 'later-refresh',
      expiresAt: 9_999_999_999_999,
      cloud: laterCloud,
      organizations,
      capabilities
    })
    await expect(connectCurrentOrcaProfile(userDataPath, openNoBrowser)).resolves.toMatchObject({
      status: 'connected'
    })
    lookup.resolve()
    await signingOut
    expect(revokeOrcaCloudSessionMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refreshToken: 'later-refresh' })
    )
    expect(await getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      state: 'connected',
      cloud: { email: 'ada@example.com' }
    })
    spy.mockRestore()
  })
})
