import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MiniMaxCookieStore from './minimax-cookie-store'
import { setSecretStore } from '../../shared/secret-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const writeSecureFileMock = vi.fn()
const homedirMock = vi.fn(() => '/home/test')

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  writeSecureFile: writeSecureFileMock
}))

const storePath = '/home/test/.orca/minimax-session-cookie.enc'
const envelope = (kind: 'encrypted' | 'plaintext', value: string): string =>
  `orca-minimax-cookie:v1:${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof MiniMaxCookieStore> {
  return await import('./minimax-cookie-store')
}

describe('minimax-cookie-store', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
    setSecretStore({ ...safeStorageMock, describeProtectionGap: () => null })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('reads decrypted cookie from disk and caches it', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValue('_token=cached; minimax_group_id_v2=9')
    const store = await loadStore()
    const first = store.readMiniMaxSessionCookie()
    const second = store.readMiniMaxSessionCookie()
    expect(first).toBe('_token=cached; minimax_group_id_v2=9')
    expect(second).toBe(first)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledTimes(1)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(Buffer.from('encrypted-payload'))
  })

  it('returns enveloped plaintext when safeStorage is unavailable and reads succeed', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', '_token=plaintext')))
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=plaintext')
  })

  it('reads legacy plaintext cookies when decrypting is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('_token=legacy'))
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy')
  })

  it('reads legacy plaintext cookies when decrypting fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('_token=legacy'))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=legacy')
  })

  it('does not treat encrypted legacy bytes as plaintext when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('encrypted-payload'))
    const store = await loadStore()
    expect(() => store.readMiniMaxSessionCookie()).toThrow(/could not be decrypted/)
  })

  it('throws for encrypted envelopes when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    const store = await loadStore()
    expect(() => store.readMiniMaxSessionCookie()).toThrow(/could not be decrypted/)
  })

  it('throws when decryption fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(() => store.readMiniMaxSessionCookie()).toThrow(/could not be decrypted/)
  })

  it('clears the cached cookie and removes the file', async () => {
    existsSyncMock.mockReturnValueOnce(true)
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('encrypted', 'encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValueOnce('_token=preclear')
    const store = await loadStore()
    expect(store.readMiniMaxSessionCookie()).toBe('_token=preclear')
    store.clearMiniMaxSessionCookie()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readMiniMaxSessionCookie()).toBeNull()
  })

  describe('getMiniMaxSessionCookieProtection', () => {
    it('does not decrypt, so opening Settings cannot trigger a keychain prompt', async () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'sessionId=abc123')))
      const store = await loadStore()
      store.getMiniMaxSessionCookieProtection()
      expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    })
  })
})
