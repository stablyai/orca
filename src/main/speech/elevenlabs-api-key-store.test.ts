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
  // Why dynamic imports: the store caches the decrypted key at module scope, so each case needs a
  // fresh module instance after resetModules() and a freshly installed SecretStore — a static
  // import would hand every case the first instance.
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    ...safeStorageMock,
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./elevenlabs-api-key-store')
}

function writeStoredElevenLabsKey(value: string): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(join(orcaDir, 'elevenlabs-speech-token.enc'), value)
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-elevenlabs-key-store-'))
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.isEncryptionAvailable.mockClear()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

describe('ElevenLabs speech API key store', () => {
  it('checks configured status without decrypting or touching safeStorage', async () => {
    writeStoredElevenLabsKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.hasElevenLabsSpeechApiKey()).toBe(true)
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('decrypts only when the key is read for an API request', async () => {
    writeStoredElevenLabsKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readElevenLabsSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('caches the decrypted key so repeated dictations do not repeatedly touch safeStorage', async () => {
    writeStoredElevenLabsKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readElevenLabsSpeechApiKey()).toBe('encrypted-key')
    expect(store.readElevenLabsSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('uses the in-memory key after save without decrypting from safeStorage', async () => {
    const store = await loadStoreModule()

    store.saveElevenLabsSpeechApiKey('saved-key')

    expect(store.readElevenLabsSpeechApiKey()).toBe('saved-key')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('persists the key in the ElevenLabs token file, not the OpenAI one', async () => {
    const store = await loadStoreModule()

    store.saveElevenLabsSpeechApiKey('saved-key')

    expect(existsSync(join(tempHome, '.orca', 'elevenlabs-speech-token.enc'))).toBe(true)
    expect(existsSync(join(tempHome, '.orca', 'openai-speech-token.enc'))).toBe(false)
  })

  it('reports missing status without creating storage files', async () => {
    const store = await loadStoreModule()

    expect(store.hasElevenLabsSpeechApiKey()).toBe(false)
    expect(existsSync(join(tempHome, '.orca'))).toBe(false)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })
})
