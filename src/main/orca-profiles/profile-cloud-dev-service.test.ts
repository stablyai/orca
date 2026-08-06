import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: beginOrcaCloudPkceFlowMock
}))

vi.mock('./profile-cloud-client', () => ({
  createOrcaCloudProfile: vi.fn(),
  exchangeOrcaCloudAuthCode: exchangeOrcaCloudAuthCodeMock,
  refreshOrcaCloudCapabilities: vi.fn(),
  refreshOrcaCloudSession: vi.fn(),
  revokeOrcaCloudSession: revokeOrcaCloudSessionMock,
  selectOrcaCloudOrg: vi.fn()
}))

import {
  connectCurrentOrcaProfile,
  createCloudLinkedOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  selectCurrentOrcaProfileOrg,
  signOutCurrentOrcaProfile
} from './profile-cloud-service'

describe('Orca cloud dev auth service', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-dev-auth-'))
    beginOrcaCloudPkceFlowMock.mockReset()
    exchangeOrcaCloudAuthCodeMock.mockReset()
    revokeOrcaCloudSessionMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('ORCA_CLOUD_DEV_AUTH', '1')
    vi.stubEnv('ORCA_CLOUD_API_URL', '')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('connects the active profile without PKCE or cloud endpoints', async () => {
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local'
    })

    const result = await connectCurrentOrcaProfile(userDataPath)

    expect(result.status).toBe('connected')
    expect(beginOrcaCloudPkceFlowMock).not.toHaveBeenCalled()
    expect(exchangeOrcaCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: {
        cloudProfileId: 'dev-cloud-local-default',
        email: 'dev@orca.local'
      },
      capabilities: {
        flags: expect.objectContaining({ 'share.create': true })
      }
    })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).organizations).toHaveLength(2)
  })

  it('selects dev organizations and creates org-scoped cloud profiles locally', async () => {
    await connectCurrentOrcaProfile(userDataPath)

    const selected = await selectCurrentOrcaProfileOrg(userDataPath, 'dev-acme')
    const created = await createCloudLinkedOrcaProfile(userDataPath, {
      orgId: 'dev-acme',
      name: 'Acme Dev'
    })

    expect(selected.status).toBe('selected')
    expect(getCurrentOrcaProfileAuthStatus(userDataPath).cloud).toMatchObject({
      activeOrgId: 'dev-acme',
      activeOrgName: 'Acme Dev'
    })
    expect(created.status).toBe('created')
    if (created.status === 'created') {
      expect(created.profile).toMatchObject({
        name: 'Acme Dev',
        kind: 'cloud-linked',
        cloud: expect.objectContaining({
          activeOrgId: 'dev-acme',
          activeOrgName: 'Acme Dev'
        })
      })
    }
  })

  it('signs out locally without calling the cloud logout endpoint', async () => {
    await connectCurrentOrcaProfile(userDataPath)

    const result = await signOutCurrentOrcaProfile(userDataPath)

    expect(result.status).toBe('signed-out')
    expect(revokeOrcaCloudSessionMock).not.toHaveBeenCalled()
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local',
      persistence: 'none'
    })
  })
})
