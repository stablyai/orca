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
  const { setSecretStore } = await import('../../shared/secure-storage/secret-store')
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
  it("does not hand out another store's ciphertext when this host stores plaintext", async () => {
    writeStoredOpenAiKey('v10\u0000\u00ff\u00fe sealed by another store')
    const store = await loadStoreModule()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    expect(store.canReadOpenAiSpeechApiKey()).toBe(false)
    expect(() => store.readOpenAiSpeechApiKey()).toThrow('OpenAI API key could not be decrypted')
  })
})
