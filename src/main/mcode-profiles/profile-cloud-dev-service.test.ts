import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  beginMCodeCloudPkceFlowMock,
  exchangeMCodeCloudAuthCodeMock,
  revokeMCodeCloudSessionMock,
  safeStorageMock
} = vi.hoisted(() => ({
  beginMCodeCloudPkceFlowMock: vi.fn(),
  exchangeMCodeCloudAuthCodeMock: vi.fn(),
  revokeMCodeCloudSessionMock: vi.fn(),
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
  createMCodeCloudProfile: vi.fn(),
  exchangeMCodeCloudAuthCode: exchangeMCodeCloudAuthCodeMock,
  refreshMCodeCloudCapabilities: vi.fn(),
  refreshMCodeCloudSession: vi.fn(),
  revokeMCodeCloudSession: revokeMCodeCloudSessionMock,
  selectMCodeCloudOrg: vi.fn()
}))

import {
  connectCurrentMCodeProfile,
  createCloudLinkedMCodeProfile,
  getCurrentMCodeProfileAuthStatus,
  selectCurrentMCodeProfileOrg,
  signOutCurrentMCodeProfile
} from './profile-cloud-service'

describe('MCode cloud dev auth service', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'mcode-cloud-dev-auth-'))
    beginMCodeCloudPkceFlowMock.mockReset()
    exchangeMCodeCloudAuthCodeMock.mockReset()
    revokeMCodeCloudSessionMock.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf-8'))
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value, 'utf-8'))
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    vi.unstubAllEnvs()
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('MCODE_CLOUD_DEV_AUTH', '1')
    vi.stubEnv('MCODE_CLOUD_API_URL', '')
    vi.stubEnv('MCODE_CLOUD_CLIENT_ID', '')
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('connects the active profile without PKCE or cloud endpoints', async () => {
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local'
    })

    const result = await connectCurrentMCodeProfile(userDataPath)

    expect(result.status).toBe('connected')
    expect(beginMCodeCloudPkceFlowMock).not.toHaveBeenCalled()
    expect(exchangeMCodeCloudAuthCodeMock).not.toHaveBeenCalled()
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'connected',
      persistence: 'encrypted',
      cloud: {
        cloudProfileId: 'dev-cloud-local-default',
        email: 'dev@mcode.local'
      },
      capabilities: {
        flags: expect.objectContaining({ 'share.create': true })
      }
    })
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).organizations).toHaveLength(2)
  })

  it('selects dev organizations and creates org-scoped cloud profiles locally', async () => {
    await connectCurrentMCodeProfile(userDataPath)

    const selected = await selectCurrentMCodeProfileOrg(userDataPath, 'dev-acme')
    const created = await createCloudLinkedMCodeProfile(userDataPath, {
      orgId: 'dev-acme',
      name: 'Acme Dev'
    })

    expect(selected.status).toBe('selected')
    expect(getCurrentMCodeProfileAuthStatus(userDataPath).cloud).toMatchObject({
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
    await connectCurrentMCodeProfile(userDataPath)

    const result = await signOutCurrentMCodeProfile(userDataPath)

    expect(result.status).toBe('signed-out')
    expect(revokeMCodeCloudSessionMock).not.toHaveBeenCalled()
    expect(getCurrentMCodeProfileAuthStatus(userDataPath)).toMatchObject({
      configured: true,
      state: 'local',
      persistence: 'none'
    })
  })
})
