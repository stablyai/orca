import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaCloudSession } from './profile-cloud-session-store'
import { setSecretStore } from '../../../shared/secure-storage/secret-store'
import { ElectronSecretStore } from '../../host/electron-secret-store'

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
    // The desktop installs this store at startup; the session file must stay readable through it.
    setSecretStore(new ElectronSecretStore())
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

  it('reads a session file written by the pre-secret-store desktop code', async () => {
    const session = makeSession()
    const profileDirectory = join(userDataPath, 'profiles', 'local-default')
    mkdirSync(profileDirectory, { recursive: true })
    // Byte-for-byte the shape the desktop wrote with electron safeStorage directly.
    writeFileSync(
      join(profileDirectory, 'account-session.json.enc'),
      JSON.stringify({
        version: 1,
        format: 'electron-safe-storage-v1',
        savedAt: 1,
        ciphertext: Buffer.from(JSON.stringify(session), 'utf-8').toString('base64')
      }),
      'utf-8'
    )
    const store = await loadSessionStore()

    expect(store.readOrcaCloudSession('local-default', userDataPath)).toEqual({
      status: 'found',
      session,
      persistence: 'encrypted'
    })
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
  })

  it('tags a host-key-sealed session so the other kind of host refuses it by name', async () => {
    const hostKeyStore = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf-8'),
      decryptString: (cipher: Buffer) => cipher.toString('utf-8'),
      describeProtectionGap: () => 'kept beside the credentials',
      describeSealing: () => ({ kind: 'host-key' as const, warning: 'kept beside the credentials' })
    }
    setSecretStore(hostKeyStore)
    let store = await loadSessionStore()
    store.saveOrcaCloudSession('local-default', userDataPath, makeSession())
    const path = store.getOrcaCloudSessionPath('local-default', userDataPath)
    expect(JSON.parse(readFileSync(path, 'utf-8')).format).toBe('orcad-host-key-v1')

    setSecretStore(new ElectronSecretStore())
    store = await loadSessionStore()
    expect(store.readOrcaCloudSession('local-default', userDataPath)).toMatchObject({
      status: 'decrypt-failed',
      error: "This Orca account sign-in was saved by Orca's headless server. Sign in again here."
    })

    store.saveOrcaCloudSession('local-default', userDataPath, makeSession())
    setSecretStore(hostKeyStore)
    store = await loadSessionStore()
    expect(store.readOrcaCloudSession('local-default', userDataPath)).toMatchObject({
      status: 'decrypt-failed',
      error: 'This Orca account sign-in was saved by the Orca app. Sign in again on this server.'
    })
  })
})
