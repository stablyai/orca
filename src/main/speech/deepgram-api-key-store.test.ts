import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./deepgram-api-key-store')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-deepgram-key-store-'))
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.isEncryptionAvailable.mockClear()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

describe('Deepgram speech API key store', () => {
  it('refuses to persist a key when encrypted credential storage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStoreModule()

    expect(() => store.saveDeepgramSpeechApiKey('dg-secret')).toThrow(
      'Encrypted credential storage is unavailable'
    )
    expect(existsSync(join(tempHome, '.orca'))).toBe(false)
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
  })

  it('does not treat a stale key file as configured without encrypted credential storage', async () => {
    const orcaDir = join(tempHome, '.orca')
    mkdirSync(orcaDir, { recursive: true })
    writeFileSync(join(orcaDir, 'deepgram-speech-token.enc'), 'plaintext-stale-key')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStoreModule()

    expect(store.hasDeepgramSpeechApiKey()).toBe(false)
    expect(() => store.readDeepgramSpeechApiKey()).toThrow(
      'Encrypted credential storage is unavailable'
    )
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('does not use an in-memory key after encrypted credential storage becomes unavailable', async () => {
    const store = await loadStoreModule()
    store.saveDeepgramSpeechApiKey('dg-secret')
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)

    expect(() => store.readDeepgramSpeechApiKey()).toThrow(
      'Encrypted credential storage is unavailable'
    )
  })

  it('drops the cached key and encrypted file when cleared', async () => {
    const store = await loadStoreModule()
    store.saveDeepgramSpeechApiKey('dg-secret')

    store.clearDeepgramSpeechApiKey()

    expect(store.hasDeepgramSpeechApiKey()).toBe(false)
    expect(() => store.readDeepgramSpeechApiKey()).toThrow('Deepgram API key is not configured')
  })
})
