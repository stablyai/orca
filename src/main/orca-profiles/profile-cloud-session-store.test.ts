import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaCloudSession } from './profile-cloud-session-store'

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
  encryptString: vi.fn((value: string) => Buffer.from(value, 'utf-8')),
  isEncryptionAvailable: vi.fn(() => true)
}))

let userDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  },
  safeStorage: safeStorageMock
}))

async function loadSessionStore() {
  vi.resetModules()
  return import('./profile-cloud-session-store')
}

function makeSession(): OrcaCloudSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 9_999,
    organizations: [
      { orgId: 'org-1', name: 'Acme', role: 'Admin' },
      { orgId: 'org-2', name: 'Personal' }
    ],
    capabilities: {
      flags: { share: true },
      refreshedAt: 123
    }
  }
}

function writePlaintextSessionFile(profileId: string, session: OrcaCloudSession): void {
  const profileDirectory = join(userDataPath, 'profiles', profileId)
  mkdirSync(profileDirectory, { recursive: true })
  writeFileSync(
    join(profileDirectory, 'account-session.json.enc'),
    JSON.stringify(
      {
        version: 1,
        format: 'dev-plaintext-v1',
        savedAt: 1,
        session
      },
      null,
      2
    ),
    'utf-8'
  )
}

describe('Orca cloud session store', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-session-'))
    vi.unstubAllEnvs()
    safeStorageMock.decryptString.mockClear()
    safeStorageMock.encryptString.mockClear()
    safeStorageMock.isEncryptionAvailable.mockClear()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('rejects dev plaintext files when the escape hatch is disabled', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    writePlaintextSessionFile('profile-1', makeSession())
    const store = await loadSessionStore()

    expect(store.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'decrypt-failed',
      persistence: 'none',
      error: 'Unsafe session format.'
    })
  })
})
