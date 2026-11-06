import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'

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
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    ...safeStorageMock,
    describeProtectionGap: () => null
  })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./openai-api-key-store')
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-openai-key-store-')
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.isEncryptionAvailable.mockClear()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

function mkdtempLike(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeStoredOpenAiKey(value: string): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(join(orcaDir, 'openai-speech-token.enc'), value)
}

describe('OpenAI speech API key store', () => {
  it('checks configured status without decrypting or touching safeStorage', async () => {
    writeStoredOpenAiKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.hasOpenAiSpeechApiKey()).toBe(true)
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  // #31174: orcad cannot open a key the desktop sealed with safeStorage, so it must not say ready.
  it('reports a stored key this host cannot decrypt as unusable', async () => {
    writeStoredOpenAiKey('v10\u0000ÿþ sealed by another store')
    const store = await loadStoreModule()
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('not our ciphertext')
    })
    try {
      expect(store.hasOpenAiSpeechApiKey()).toBe(true)
      expect(store.canReadOpenAiSpeechApiKey()).toBe(false)
    } finally {
      safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
    }
  })

  it("does not hand out another store's ciphertext when this host stores plaintext", async () => {
    writeStoredOpenAiKey('v10\u0000\u00ff\u00fe sealed by another store')
    const store = await loadStoreModule()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    expect(store.canReadOpenAiSpeechApiKey()).toBe(false)
    expect(() => store.readOpenAiSpeechApiKey()).toThrow('OpenAI API key could not be decrypted')
  })

  it('caches the decrypted key so repeated dictations do not repeatedly touch safeStorage', async () => {
    writeStoredOpenAiKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })
})
