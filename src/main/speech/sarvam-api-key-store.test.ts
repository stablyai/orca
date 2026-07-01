import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  isEncryptionAvailable: vi.fn(() => true)
}))

let tempHome = ''

async function loadStoreModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    safeStorage: safeStorageMock
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./sarvam-api-key-store')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-sarvam-key-store-'))
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.isEncryptionAvailable.mockClear()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

function writeStoredSarvamKey(value: string): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(join(orcaDir, 'sarvam-speech-token.enc'), value)
}

describe('Sarvam speech API key store', () => {
  it('checks configured status without decrypting or touching safeStorage', async () => {
    writeStoredSarvamKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.hasSarvamSpeechApiKey()).toBe(true)
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('decrypts only when the key is read for an API request', async () => {
    writeStoredSarvamKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readSarvamSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('caches the decrypted key so repeated dictations do not repeatedly touch safeStorage', async () => {
    writeStoredSarvamKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readSarvamSpeechApiKey()).toBe('encrypted-key')
    expect(store.readSarvamSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('uses the in-memory key after save without decrypting from safeStorage', async () => {
    const store = await loadStoreModule()

    store.saveSarvamSpeechApiKey('saved-key')

    expect(store.readSarvamSpeechApiKey()).toBe('saved-key')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('stores the key in plaintext when safeStorage encryption is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStoreModule()

    store.saveSarvamSpeechApiKey('plain-key')

    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
    expect(store.readSarvamSpeechApiKey()).toBe('plain-key')
  })

  it('reports missing status without creating storage files', async () => {
    const store = await loadStoreModule()

    expect(store.hasSarvamSpeechApiKey()).toBe(false)
    expect(existsSync(join(tempHome, '.orca'))).toBe(false)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('clears the stored key', async () => {
    writeStoredSarvamKey('encrypted-key')
    const store = await loadStoreModule()

    store.clearSarvamSpeechApiKey()

    expect(store.hasSarvamSpeechApiKey()).toBe(false)
  })
})
