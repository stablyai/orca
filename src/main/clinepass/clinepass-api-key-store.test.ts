import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClinePassApiKeyStore from './clinepass-api-key-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret')
}))

const electronMock = vi.hoisted(() => ({
  safeStorage: safeStorageMock
}))

vi.mock('electron', () => electronMock)

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

const storePath = '/home/test/.orca/clinepass-api-key.enc'
const envelope = (value: string): string =>
  `orca-clinepass-api-key:v1:encrypted:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof ClinePassApiKeyStore> {
  return await import('./clinepass-api-key-store')
}

describe('clinepass-api-key-store', () => {
  const originalEnv = process.env.CLINE_API_KEY
  const originalPlatform = process.platform

  beforeEach(() => {
    delete process.env.CLINE_API_KEY
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.getSelectedStorageBackend.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLINE_API_KEY
    } else {
      process.env.CLINE_API_KEY = originalEnv
    }
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    vi.resetModules()
  })

  it('returns none status when no stored key or environment key exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.getClinePassCredentialsStatus()).toEqual({ configured: false, source: 'none' })
    expect(store.hasClinePassApiKey()).toBe(false)
    expect(store.readClinePassApiKey()).toBeNull()
    expect(hardenExistingSecureFileMock).not.toHaveBeenCalled()
  })

  it('hardens the key file when checking stored status', async () => {
    existsSyncMock.mockReturnValue(true)
    const store = await loadStore()
    expect(store.getClinePassCredentialsStatus()).toEqual({ configured: true, source: 'stored' })
    expect(store.hasClinePassApiKey()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('still reports a stored key when status-path hardening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    hardenExistingSecureFileMock.mockImplementation(() => {
      throw new Error('permission denied')
    })
    const store = await loadStore()
    expect(store.getClinePassCredentialsStatus()).toEqual({ configured: true, source: 'stored' })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to harden ClinePass API key file'),
      expect.any(Error)
    )
    warn.mockRestore()
  })

  it('prefers stored source over environment when both are present', async () => {
    process.env.CLINE_API_KEY = 'env-key'
    existsSyncMock.mockReturnValue(true)
    const store = await loadStore()
    expect(store.getClinePassCredentialsStatus()).toEqual({ configured: true, source: 'stored' })
  })

  it('reports environment source when only CLINE_API_KEY is set', async () => {
    process.env.CLINE_API_KEY = '  env-only-key  '
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.getClinePassCredentialsStatus()).toEqual({
      configured: true,
      source: 'environment'
    })
    expect(store.hasClinePassApiKey()).toBe(true)
    expect(store.readClinePassApiKey()).toBe('env-only-key')
  })

  it('ignores blank environment keys', async () => {
    process.env.CLINE_API_KEY = '   '
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.getClinePassCredentialsStatus()).toEqual({ configured: false, source: 'none' })
    expect(store.readClinePassApiKey()).toBeNull()
  })

  it('writes the key using safeStorage when encryption is available', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    store.saveClinePassApiKey(' cp_live_abc ')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('cp_live_abc')
    expect(writeSecureFileMock).toHaveBeenCalledWith(storePath, envelope('cp_live_abc'))
    expect(store.readClinePassApiKey()).toBe('cp_live_abc')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('refuses to persist when safeStorage encryption is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(() => store.saveClinePassApiKey('cp_live_plain')).toThrow(/CLINE_API_KEY/)
    expect(writeSecureFileMock).not.toHaveBeenCalled()
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
  })

  it('refuses to persist on Linux when safeStorage backend is basic_text', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text')
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(() => store.saveClinePassApiKey('cp_live_basic')).toThrow(/CLINE_API_KEY/)
    expect(writeSecureFileMock).not.toHaveBeenCalled()
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
  })

  it('refuses empty API keys', async () => {
    const store = await loadStore()
    expect(() => store.saveClinePassApiKey('   ')).toThrow(/required/)
  })

  it('reads decrypted key from disk and caches it', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValue('cp_live_cached')
    const store = await loadStore()
    const first = store.readClinePassApiKey()
    const second = store.readClinePassApiKey()
    expect(first).toBe('cp_live_cached')
    expect(second).toBe(first)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledTimes(1)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(Buffer.from('encrypted-payload'))
  })

  it('prefers stored key over environment when reading', async () => {
    process.env.CLINE_API_KEY = 'env-key'
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValue('stored-key')
    const store = await loadStore()
    expect(store.readClinePassApiKey()).toBe('stored-key')
  })

  it('fails closed when reading a stored key without secure storage', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted-payload')))
    const store = await loadStore()
    expect(() => store.readClinePassApiKey()).toThrow(/could not be decrypted/)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('fails closed when reading a stored key on Linux basic_text backend', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text')
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted-payload')))
    const store = await loadStore()
    expect(() => store.readClinePassApiKey()).toThrow(/could not be decrypted/)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('throws when decryption fails', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted-payload')))
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('boom')
    })
    const store = await loadStore()
    expect(() => store.readClinePassApiKey()).toThrow(/could not be decrypted/)
  })

  it('clears the cached key and removes the file', async () => {
    existsSyncMock.mockReturnValueOnce(true)
    readFileSyncMock.mockReturnValueOnce(Buffer.from(envelope('encrypted-payload')))
    safeStorageMock.decryptString.mockReturnValueOnce('cp_live_preclear')
    const store = await loadStore()
    expect(store.readClinePassApiKey()).toBe('cp_live_preclear')
    store.clearClinePassApiKey()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    existsSyncMock.mockReturnValue(false)
    expect(store.readClinePassApiKey()).toBeNull()
    expect(store.getClinePassCredentialsStatus()).toEqual({ configured: false, source: 'none' })
  })
})
