import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'

const testHome = vi.hoisted(() => ({ path: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => testHome.path }
})

import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secure-storage/secret-store'
import { createEncryptedApiKeyFileStoreAsync } from './encrypted-api-key-file-store-async'

const fileName = 'ollama-cloud-api-key.enc'
const envelopePrefix = 'orca-ollama-cloud-api-key:v1:'

function createStore() {
  return createEncryptedApiKeyFileStoreAsync({
    fileName,
    envelopePrefix,
    providerLabel: 'Ollama cloud',
    logScope: 'ollama',
    singleLine: true,
    requireRestrictedPlaintext: true
  })
}

function setTestSecretStore(encryptionAvailable: boolean): void {
  setSecretStore({
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString('utf8'),
    describeProtectionGap: () => null
  })
}

describe('async encrypted API key file store', () => {
  beforeEach(async () => {
    testHome.path = await mkdtemp(join(tmpdir(), 'orca-api-key-store-'))
    setTestSecretStore(true)
  })

  afterEach(async () => {
    _resetSecretStoreForTests()
    await rm(testHome.path, { recursive: true, force: true })
  })

  it('round trips an encrypted key and clears it', async () => {
    const store = createStore()

    await store.save(' secret ')

    expect(await store.read()).toBe('secret')
    expect(await store.protection()).toBe('sealed')
    expect(await store.has()).toBe(true)
    await store.clear()
    expect(await store.read()).toBeNull()
  })

  it('stores plaintext only with owner-only file permissions', async () => {
    setTestSecretStore(false)
    const store = createStore()

    if (process.platform === 'win32') {
      await expect(store.save('secret')).rejects.toThrow('could not be stored securely')
      expect(await store.has()).toBe(false)
      return
    }

    await store.save('secret')
    const keyPath = join(testHome.path, '.orca', fileName)
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
    expect((await readFile(keyPath, 'utf8')).startsWith(`${envelopePrefix}plaintext:`)).toBe(true)
    expect(await store.read()).toBe('secret')
  })

  it('rejects multiline keys before writing', async () => {
    const store = createStore()

    await expect(store.save('secret\nother')).rejects.toThrow('must be a single line')
    expect(await store.has()).toBe(false)
  })
})
