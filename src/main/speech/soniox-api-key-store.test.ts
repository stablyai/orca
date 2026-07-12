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
  vi.doMock('electron', () => ({ safeStorage: safeStorageMock }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./soniox-api-key-store')
}

function writeStoredKey(value: string): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(join(orcaDir, 'soniox-speech-token.enc'), value)
}

describe('Soniox speech API key store', () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'orca-soniox-key-store-'))
    safeStorageMock.decryptString.mockClear()
    safeStorageMock.encryptString.mockClear()
    safeStorageMock.isEncryptionAvailable.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  })

  it('checks status without decrypting or touching safeStorage', async () => {
    writeStoredKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.hasSonioxSpeechApiKey()).toBe(true)
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('saves and serves the in-memory key without decrypting it again', async () => {
    const store = await loadStoreModule()

    store.saveSonioxSpeechApiKey(' saved-key ')

    expect(store.readSonioxSpeechApiKey()).toBe('saved-key')
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith('saved-key')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('decrypts a stored key only once across repeated reads', async () => {
    writeStoredKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readSonioxSpeechApiKey()).toBe('encrypted-key')
    expect(store.readSonioxSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('clears persisted and cached credentials', async () => {
    const store = await loadStoreModule()
    store.saveSonioxSpeechApiKey('saved-key')

    store.clearSonioxSpeechApiKey()

    expect(store.hasSonioxSpeechApiKey()).toBe(false)
    expect(() => store.readSonioxSpeechApiKey()).toThrow('Soniox API key is not configured')
    expect(existsSync(join(tempHome, '.orca', 'soniox-speech-token.enc'))).toBe(false)
  })

  it('uses a mode-0600 plaintext fallback when encryption is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStoreModule()

    store.saveSonioxSpeechApiKey('fallback-key')

    expect(store.readSonioxSpeechApiKey()).toBe('fallback-key')
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
  })
})
