import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
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

  it('persists encrypted sessions and reports encrypted persistence from memory and disk', async () => {
    const store = await loadSessionStore()
    const session = makeSession()

    expect(store.saveOrcaCloudSession('profile-1', userDataPath, session)).toBe('encrypted')
    expect(store.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'found',
      session,
      persistence: 'encrypted'
    })

    const reloaded = await loadSessionStore()
    expect(reloaded.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'found',
      session,
      persistence: 'encrypted'
    })
  })

  it('falls back to memory-only when encryption is unavailable and plaintext is not allowed', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadSessionStore()
    const session = makeSession()

    expect(store.saveOrcaCloudSession('profile-1', userDataPath, session)).toBe('memory-only')
    expect(store.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'found',
      session,
      persistence: 'memory-only'
    })

    const reloaded = await loadSessionStore()
    expect(reloaded.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'missing',
      persistence: 'none'
    })
  })

  it('scopes memory-only sessions by user-data path and profile ID', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const otherUserDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-session-other-'))
    const store = await loadSessionStore()
    const session = makeSession()
    const otherSession = { ...session, accessToken: 'other-access-token' }

    try {
      store.saveOrcaCloudSession('local-default', userDataPath, session)
      store.saveOrcaCloudSession('local-default', otherUserDataPath, otherSession)

      expect(store.readOrcaCloudSession('local-default', userDataPath)).toMatchObject({
        status: 'found',
        session
      })
      expect(store.readOrcaCloudSession('local-default', otherUserDataPath)).toMatchObject({
        status: 'found',
        session: otherSession
      })
    } finally {
      rmSync(otherUserDataPath, { recursive: true, force: true })
    }
  })

  it('writes explicit dev plaintext only when the dev escape hatch is enabled', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    vi.stubEnv('ORCA_CLOUD_ALLOW_PLAINTEXT_SESSION', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const store = await loadSessionStore()
    const session = makeSession()

    expect(store.saveOrcaCloudSession('profile-1', userDataPath, session)).toBe('dev-plaintext')

    const saved = JSON.parse(
      readFileSync(store.getOrcaCloudSessionPath('profile-1', userDataPath), 'utf-8')
    ) as { format: string }
    expect(saved.format).toBe('dev-plaintext-v1')

    const reloaded = await loadSessionStore()
    expect(reloaded.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'found',
      session,
      persistence: 'dev-plaintext'
    })
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

  it('rejects an oversized sparse encrypted-session wrapper before decrypting', async () => {
    writePlaintextSessionFile('profile-1', makeSession())
    const store = await loadSessionStore()
    truncateSync(
      store.getOrcaCloudSessionPath('profile-1', userDataPath),
      store.MAX_ORCA_CLOUD_SESSION_FILE_BYTES + 1
    )

    expect(store.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'decrypt-failed',
      persistence: 'none',
      error: 'Could not decrypt saved Orca account session.'
    })
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('rejects an oversized session without replacing the prior durable or cached session', async () => {
    const store = await loadSessionStore()
    const session = makeSession()
    store.saveOrcaCloudSession('profile-1', userDataPath, session)
    const path = store.getOrcaCloudSessionPath('profile-1', userDataPath)
    const durableBefore = readFileSync(path, 'utf-8')

    expect(() =>
      store.saveOrcaCloudSession('profile-1', userDataPath, {
        ...session,
        accessToken: 'x'.repeat(store.MAX_ORCA_CLOUD_SESSION_PAYLOAD_BYTES)
      })
    ).toThrow(`JSON output exceeds ${store.MAX_ORCA_CLOUD_SESSION_PAYLOAD_BYTES} bytes`)
    expect(readFileSync(path, 'utf-8')).toBe(durableBefore)
    expect(store.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'found',
      session,
      persistence: 'encrypted'
    })
  })

  it('removes stale durable credentials when encryption expansion exceeds the file limit', async () => {
    const store = await loadSessionStore()
    const prior = makeSession()
    store.saveOrcaCloudSession('profile-1', userDataPath, prior)
    const session = {
      ...prior,
      accessToken: 'x'.repeat(Math.floor(store.MAX_ORCA_CLOUD_SESSION_FILE_BYTES * 0.8))
    }

    expect(store.saveOrcaCloudSession('profile-1', userDataPath, session)).toBe('memory-only')
    expect(existsSync(store.getOrcaCloudSessionPath('profile-1', userDataPath))).toBe(false)
    expect(store.readOrcaCloudSession('profile-1', userDataPath)).toEqual({
      status: 'found',
      session,
      persistence: 'memory-only'
    })
  })

  it('evicts the least-recently-used memory-only session at the entry limit', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadSessionStore()
    const session = makeSession()

    for (let index = 0; index <= store.MAX_ORCA_CLOUD_MEMORY_SESSIONS; index += 1) {
      store.saveOrcaCloudSession(`profile-${index}`, userDataPath, session)
    }

    expect(store.readOrcaCloudSession('profile-0', userDataPath)).toEqual({
      status: 'missing',
      persistence: 'none'
    })
    expect(
      store.readOrcaCloudSession(`profile-${store.MAX_ORCA_CLOUD_MEMORY_SESSIONS}`, userDataPath)
    ).toMatchObject({ status: 'found', session })
  })

  it('evicts memory-only sessions before exceeding the aggregate byte limit', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadSessionStore()
    const session = {
      ...makeSession(),
      accessToken: 'x'.repeat(store.MAX_ORCA_CLOUD_SESSION_PAYLOAD_BYTES - 1024)
    }
    const writesNeeded =
      Math.floor(
        store.MAX_ORCA_CLOUD_MEMORY_SESSION_BYTES / store.MAX_ORCA_CLOUD_SESSION_PAYLOAD_BYTES
      ) + 2

    for (let index = 0; index < writesNeeded; index += 1) {
      store.saveOrcaCloudSession(`profile-${index}`, userDataPath, session)
    }

    expect(store.readOrcaCloudSession('profile-0', userDataPath)).toMatchObject({
      status: 'missing'
    })
    expect(store.readOrcaCloudSession(`profile-${writesNeeded - 1}`, userDataPath)).toMatchObject({
      status: 'found',
      session
    })
  })
})
