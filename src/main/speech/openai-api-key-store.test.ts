import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  isEncryptionAvailable: vi.fn(() => true)
}))
const readSnapshotFileMock = vi.hoisted(() => vi.fn())

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
  vi.doMock('../filesystem-host/filesystem-host-read-authority', () => ({
    readSnapshotFileThroughFilesystemHost: readSnapshotFileMock
  }))
  return import('./openai-api-key-store')
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-openai-key-store-')
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.isEncryptionAvailable.mockClear()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  readSnapshotFileMock.mockReset()
  readSnapshotFileMock.mockImplementation(async (path) => readFileSync(path))
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
  it('hydrates configured status once without decrypting or touching safeStorage', async () => {
    writeStoredOpenAiKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.hasOpenAiSpeechApiKey()).toBe(false)
    expect(store.getOpenAiSpeechApiKeySnapshot().availability).toBe('unavailable')
    await store.hydrateOpenAiSpeechApiKeySnapshot()
    expect(store.hasOpenAiSpeechApiKey()).toBe(true)
    expect(readSnapshotFileMock).toHaveBeenCalledWith(
      join(tempHome, '.orca', 'openai-speech-token.enc'),
      'openai-speech-key'
    )
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('decrypts only when the key is read for an API request', async () => {
    writeStoredOpenAiKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('publishes configured status after reading the legacy envelope', async () => {
    writeStoredOpenAiKey(
      JSON.stringify({ encryptedKeyBase64: Buffer.from('legacy-key').toString('base64') })
    )
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('legacy-key')
    expect(store.getOpenAiSpeechApiKeySnapshot()).toMatchObject({
      value: true,
      stale: false,
      availability: 'ready'
    })
  })

  it('caches the decrypted key so repeated dictations do not repeatedly touch safeStorage', async () => {
    writeStoredOpenAiKey('encrypted-key')
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('uses the in-memory key after save without decrypting from safeStorage', async () => {
    const store = await loadStoreModule()

    await store.saveOpenAiSpeechApiKey('saved-key')

    expect(store.readOpenAiSpeechApiKey()).toBe('saved-key')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    expect(safeStorageMock.encryptString).toHaveBeenCalledOnce()
    expect(
      readFileSync(join(tempHome, '.orca', 'openai-speech-token.enc')).equals(
        Buffer.from('saved-key')
      )
    ).toBe(true)
  })

  it('reports missing status without creating storage files', async () => {
    const store = await loadStoreModule()

    await store.hydrateOpenAiSpeechApiKeySnapshot()
    expect(store.hasOpenAiSpeechApiKey()).toBe(false)
    expect(existsSync(join(tempHome, '.orca'))).toBe(false)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('serves repeated status reads from memory after hydration', async () => {
    writeStoredOpenAiKey('encrypted-key')
    const store = await loadStoreModule()

    await store.hydrateOpenAiSpeechApiKeySnapshot()
    const first = store.getOpenAiSpeechApiKeySnapshot()
    const second = store.getOpenAiSpeechApiKeySnapshot()

    expect(first).toMatchObject({ value: true, stale: false, availability: 'ready' })
    expect(second.value).toBe(true)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('publishes revocation after removing persisted state', async () => {
    writeStoredOpenAiKey('encrypted-key')
    const store = await loadStoreModule()
    await store.hydrateOpenAiSpeechApiKeySnapshot()

    await store.clearOpenAiSpeechApiKey()

    expect(store.getOpenAiSpeechApiKeySnapshot()).toMatchObject({
      value: false,
      stale: false,
      availability: 'missing'
    })
  })

  it('preserves exact plaintext bytes when safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = await loadStoreModule()

    await store.saveOpenAiSpeechApiKey(' plaintext-key ')

    expect(readFileSync(join(tempHome, '.orca', 'openai-speech-token.enc'), 'utf8')).toBe(
      'plaintext-key'
    )
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('marks the snapshot unavailable when the write fails', async () => {
    writeFileSync(join(tempHome, '.orca'), 'not-a-directory')
    const store = await loadStoreModule()

    expect(() => store.saveOpenAiSpeechApiKey('after')).toThrow()

    expect(store.getOpenAiSpeechApiKeySnapshot()).toMatchObject({
      value: false,
      stale: true,
      availability: 'unavailable'
    })
  })
})
