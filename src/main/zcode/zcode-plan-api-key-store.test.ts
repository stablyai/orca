import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secret-store'
import type * as ZcodePlanApiKeyStore from './zcode-plan-api-key-store'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

beforeEach(() => setSecretStore({ ...safeStorageMock, describeProtectionGap: () => null }))

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

vi.mock('../../shared/secure-storage/secure-file', () => ({
  hardenExistingSecureFile: hardenExistingSecureFileMock,
  writeSecureFile: writeSecureFileMock
}))

const storePath = '/home/test/.orca/zcode-plan-api-key.enc'
const envelope = (kind: 'encrypted' | 'plaintext', value: string): string =>
  `orca-zcode-plan-api-key:v1:${kind}:${Buffer.from(value, 'utf8').toString('base64')}`

async function loadStore(): Promise<typeof ZcodePlanApiKeyStore> {
  return await import('./zcode-plan-api-key-store')
}

describe('zcode-plan-api-key-store', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    rmSyncMock.mockReset()
    hardenExistingSecureFileMock.mockReset()
    writeSecureFileMock.mockReset()
    writeSecureFileMock.mockReturnValue(true)
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.encryptString.mockReset()
    safeStorageMock.decryptString.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
    homedirMock.mockReturnValue('/home/test')
    vi.resetModules()
  })

  it('rejects a key with an interior newline instead of saving it', async () => {
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('glm\r\nsecret')).toThrow('must be a single line')
    expect(writeSecureFileMock).not.toHaveBeenCalled()
  })

  it('refuses to keep an unrestricted plaintext key when hardening fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    writeSecureFileMock.mockReturnValue(false)
    existsSyncMock.mockReturnValue(false)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('plaintext', 'glm-secret')))
    const store = await loadStore()

    expect(() => store.saveZcodePlanApiKey('glm-secret')).toThrow(
      'could not be stored securely on this device'
    )
    expect(rmSyncMock).toHaveBeenCalledWith(storePath, { force: true })
    warn.mockRestore()
  })

  it('refuses to decrypt an encrypted envelope once safeStorage becomes unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from(envelope('encrypted', 'glm-secret')))
    const store = await loadStore()

    expect(() => store.readZcodePlanApiKey()).toThrow('could not be decrypted')
  })

  it('throws on an unreadable envelope instead of returning a partial key', async () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue(Buffer.from('not-an-envelope'))
    const store = await loadStore()

    expect(() => store.readZcodePlanApiKey()).toThrow('could not be decrypted')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
