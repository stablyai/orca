import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ProfileCloudClient from './profile-cloud-client'
import type * as SecureFile from '../../shared/secure-storage/secure-file'
import type * as Fs from 'node:fs'
import type * as ProfileIndexStore from './profile-index-store'

const { refreshMock, selectOrgMock, linkMock, linked, writeFailure, removeFailure } = vi.hoisted(
  () => {
    const writeFailure: { code: string | null; onlyFile?: string; times?: number } = { code: null }
    const removeFailure: { code: string | null } = { code: null }
    const linked: { cloud: unknown } = { cloud: undefined }
    return {
      refreshMock: vi.fn(),
      selectOrgMock: vi.fn(),
      linkMock: vi.fn(),
      linked,
      writeFailure,
      removeFailure
    }
  }
)

// Simulate Windows antivirus holding a session file open against deletion.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>()
  return {
    ...original,
    rmSync: (...args: Parameters<typeof original.rmSync>) => {
      if (removeFailure.code && String(args[0]).endsWith('account-session.json.enc')) {
        throw Object.assign(new Error(`${removeFailure.code}: remove failed`), {
          code: removeFailure.code
        })
      }
      return original.rmSync(...args)
    }
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (value: Buffer) => value.toString('utf-8'),
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    isEncryptionAvailable: () => true
  }
}))

vi.mock('../../shared/secure-storage/secure-file', async (importOriginal) => {
  const original = await importOriginal<typeof SecureFile>()
  return {
    ...original,
    writeSecureJsonFile: (path: string, value: unknown) => {
      if (writeFailure.code && (!writeFailure.onlyFile || path.endsWith(writeFailure.onlyFile))) {
        if (writeFailure.times !== undefined && --writeFailure.times <= 0) {
          writeFailure.code = null
        }
        throw Object.assign(new Error(`${writeFailure.code}: write failed`), {
          code: writeFailure.code
        })
      }
      return original.writeSecureJsonFile(path, value)
    }
  }
})

vi.mock('./profile-cloud-client', async (importOriginal) => {
  const original = await importOriginal<typeof ProfileCloudClient>()
  return {
    ...original,
    refreshOrcaCloudSession: refreshMock,
    selectOrcaCloudOrg: selectOrgMock
  }
})

vi.mock('./profile-cloud-index', () => ({ linkOrcaProfileToCloud: linkMock }))

vi.mock('./profile-index-store', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileIndexStore>()),
  loadOrCreateProfileIndex: () => ({ profiles: [{ id: 'profile-1', cloud: linked.cloud }] }),
  getOrcaProfileListState: () => ({ activeProfileId: 'profile-1', profiles: [] })
}))
import {
  commitCloudSessionCapabilities,
  signInCloudSession,
  takeCloudSessionTicket
} from './profile-cloud-session-owner'
const cloud = {
  userId: 'user-1',
  cloudProfileId: 'cloud-profile-1',
  email: 'user@example.com',
  activeOrgId: 'org-1',
  linkedAt: 1
}

function signIn(): void {
  signInCloudSession('profile-1', userDataPath, {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAt: Date.now() + 1_000,
    organizations: [],
    capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() },
    cloud
  })
}

let userDataPath = ''

describe('cloud session refresh-token rotation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-refresh-rotation-'))
    writeFailure.code = null
    writeFailure.onlyFile = undefined
    writeFailure.times = undefined
    removeFailure.code = null
    refreshMock.mockReset()
    selectOrgMock.mockReset()
    linkMock.mockReset()
    linked.cloud = cloud
    linkMock.mockImplementation((_profileId: string, next: unknown) => {
      linked.cloud = next
      return { activeProfileId: 'profile-1', profiles: [] }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('refuses a capability reply begun before the org moved, even after it moved back', async () => {
    signIn()
    const ticket = takeCloudSessionTicket('profile-1', userDataPath)
    for (const orgId of ['org-2', 'org-1']) {
      commitCloudSessionCapabilities(
        'profile-1',
        userDataPath,
        takeCloudSessionTicket('profile-1', userDataPath),
        {
          cloud: { ...cloud, activeOrgId: orgId },
          capabilities: { flags: {}, refreshedAt: Date.now() }
        }
      )
    }

    expect(
      commitCloudSessionCapabilities('profile-1', userDataPath, ticket, {
        cloud,
        capabilities: { flags: { stale: true }, refreshedAt: Date.now() }
      })
    ).toBeNull()
  })
})
