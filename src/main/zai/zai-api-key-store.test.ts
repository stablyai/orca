import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ZaiApiKeyStore from './zai-api-key-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

const existsSyncMock = vi.fn()
const readFileSyncMock = vi.fn()
const rmSyncMock = vi.fn()
const hardenExistingSecureFileMock = vi.fn()
const writeSecureFileMock = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('node:os', () => ({ homedir: () => '/home/test' }))
vi.mock('node:path', () => ({ join: (...parts: string[]) => parts.join('/') }))
vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  writeSecureFile: writeSecureFileMock
}))

const storePath = '/home/test/.orca/zai-api-key.enc'

async function loadStore(): Promise<typeof ZaiApiKeyStore> {
  return await import('./zai-api-key-store')
}

describe('zai-api-key-store', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.getSelectedStorageBackend.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('writes an encrypted envelope when safeStorage is available', async () => {
    const store = await loadStore()
    store.saveZaiApiKey('  zai-secret  ')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('zai-secret')
    expect(writeSecureFileMock).toHaveBeenCalledWith(
      storePath,
      `orca-zai-api-key:v1:${Buffer.from('zai-secret').toString('base64')}`
    )
  })

  it('refuses to store plaintext when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStore()
    expect(() => store.saveZaiApiKey('zai-secret')).toThrow(/encryption is unavailable/i)
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('rejects the insecure Linux basic_text backend on save', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text')
    const store = await loadStore()
    expect(() => store.saveZaiApiKey('zai-secret')).toThrow(/backend is insecure/i)
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('accepts a secure Linux safeStorage backend', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
    const store = await loadStore()
    store.saveZaiApiKey('zai-secret')
    expect(writeSecureFileMock).toHaveBeenCalledTimes(1)
  })

  it('reads and caches the decrypted API key', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(`orca-zai-api-key:v1:${Buffer.from('encrypted-payload').toString('base64')}`)
    )
    safeStorageMock.decryptString.mockReturnValue('zai-secret')
    const store = await loadStore()
    expect(store.readZaiApiKey()).toBe('zai-secret')
    expect(store.readZaiApiKey()).toBe('zai-secret')
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('reports configuration from the hardened secure file path', async () => {
    existsSyncMock.mockReturnValue(true)
    const store = await loadStore()
    expect(store.hasZaiApiKey()).toBe(true)
    expect(hardenExistingSecureFileMock).toHaveBeenCalledWith(storePath)
  })

  it('returns null when no API key file exists', async () => {
    existsSyncMock.mockReturnValue(false)
    const store = await loadStore()
    expect(store.readZaiApiKey()).toBeNull()
    expect(store.hasZaiApiKey()).toBe(false)
  })

  it('throws when decrypting requires unavailable safeStorage', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(
      Buffer.from(`orca-zai-api-key:v1:${Buffer.from('encrypted-payload').toString('base64')}`)
    )
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = await loadStore()
    expect(() => store.readZaiApiKey()).toThrow(/could not be decrypted/i)
    expect(errorSpy).toHaveBeenCalledWith(
      '[zai] failed to decode/decrypt API key',
      expect.any(Error)
    )
  })

  it('rejects the insecure Linux basic_text backend on read', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    existsSyncMock.mockReturnValue(true)
    safeStorageMock.getSelectedStorageBackend.mockReturnValue('basic_text')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = await loadStore()
    expect(() => store.readZaiApiKey()).toThrow(/backend is insecure/i)
    expect(errorSpy).toHaveBeenCalledWith(
      '[zai] failed to decode/decrypt API key',
      expect.any(Error)
    )
  })

  it('clears the cached API key and removes the file', async () => {
    existsSyncMock.mockReturnValueOnce(true).mockReturnValueOnce(false)
    readFileSyncMock.mockReturnValueOnce(
      Buffer.from(`orca-zai-api-key:v1:${Buffer.from('encrypted-payload').toString('base64')}`)
    )
    safeStorageMock.decryptString.mockReturnValueOnce('zai-secret')
    const store = await loadStore()
    expect(store.readZaiApiKey()).toBe('zai-secret')
    store.clearZaiApiKey()
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    expect(store.readZaiApiKey()).toBeNull()
  })
})
