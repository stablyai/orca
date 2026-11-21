import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  OrcaCloudCapabilities,
  OrcaCloudOrgSummary,
  OrcaProfileCloudSummary
} from '../../shared/orca-profiles/orca-profiles'

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

vi.mock('./cloud-auth/profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./cloud-auth/profile-cloud-client', () => ({
  createOrcaCloudProfile: createOrcaCloudProfileMock,
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  revokeOrcaCloudSession: revokeOrcaCloudSessionMock,
  selectOrcaCloudOrg: vi.fn()
}))

import { OrcaAccountService } from './orca-account-service'
import { loadOrCreateProfileIndex } from './profile-index-store'

// The PKCE flow is mocked, so no browser opens.
const openNoBrowser = async (): Promise<void> => {}

const cloud: OrcaProfileCloudSummary = {
  cloudProfileId: 'cloud-profile-1',
  userId: 'user-1',
  email: 'nina@example.com',
  displayName: 'Nina',
  linkedAt: 10
}

const capabilities: OrcaCloudCapabilities = { flags: { share: true }, refreshedAt: 11 }
const organizations: OrcaCloudOrgSummary[] = [{ orgId: 'org-1', name: 'Acme', role: 'Admin' }]
const farFuture = Date.parse('2100-01-01T00:00:00.000Z')

describe('Orca cloud profile creation vs server switch', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-server-switch-'))
    createOrcaCloudProfileMock.mockReset()
    revokeOrcaCloudSessionMock.mockReset()
    revokeOrcaCloudSessionMock.mockResolvedValue(undefined)
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
      expiresAt: farFuture,
      cloud,
      organizations,
      capabilities
    })
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
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
        expiresAt: farFuture,
        cloud: { ...cloud, cloudProfileId: 'cloud-profile-2', email: 'ada@example.com' },
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
