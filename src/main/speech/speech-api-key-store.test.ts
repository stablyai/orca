import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const secretStoreMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')),
  encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  isEncryptionAvailable: vi.fn(() => true),
  describeProtectionGap: () => null
}))

let tempHome = ''
type Provider = 'OpenAI' | 'OpenRouter'
const tokenFiles = { OpenAI: 'openai-speech-token.enc', OpenRouter: 'openrouter-speech-token.enc' }
const keyPath = (provider: Provider): string => join(tempHome, '.orca', tokenFiles[provider])

async function loadStoreModule(provider: Provider) {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore(secretStoreMock)
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  return importProviderStore(provider)
}

async function importProviderStore(provider: Provider) {
  if (provider === 'OpenAI') {
    const store = await import('./openai-api-key-store')
    return {
      has: store.hasOpenAiSpeechApiKey,
      save: store.saveOpenAiSpeechApiKey,
      read: store.readOpenAiSpeechApiKey,
      clear: store.clearOpenAiSpeechApiKey
    }
  }
  const store = await import('./openrouter-api-key-store')
  return {
    has: store.hasOpenRouterSpeechApiKey,
    save: store.saveOpenRouterSpeechApiKey,
    read: store.readOpenRouterSpeechApiKey,
    clear: store.clearOpenRouterSpeechApiKey
  }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-speech-key-store-'))
  secretStoreMock.decryptString.mockReset()
  secretStoreMock.decryptString.mockImplementation((value) =>
    value.toString('utf8').replace(/^encrypted:/, '')
  )
  secretStoreMock.encryptString.mockClear()
  secretStoreMock.isEncryptionAvailable.mockReset()
  secretStoreMock.isEncryptionAvailable.mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tempHome, { recursive: true, force: true })
})

describe.each(['OpenAI', 'OpenRouter'] as const)('%s speech API key store', (provider) => {
  it('reports missing status without creating storage or touching secret storage', async () => {
    const store = await loadStoreModule(provider)
    expect(store.has()).toBe(false)
    expect(existsSync(join(tempHome, '.orca'))).toBe(false)
    expect(secretStoreMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(() => store.read()).toThrow(`${provider} API key is not configured`)
  })

  it('checks configured status without decrypting or triggering keychain access', async () => {
    mkdirSync(join(tempHome, '.orca'))
    writeFileSync(keyPath(provider), 'encrypted:saved-key')
    const store = await loadStoreModule(provider)
    expect(store.has()).toBe(true)
    expect(secretStoreMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(secretStoreMock.decryptString).not.toHaveBeenCalled()
  })

  it('encrypts a trimmed key and reuses its cached value after saving', async () => {
    const store = await loadStoreModule(provider)
    store.save('  saved-key \n')
    expect(secretStoreMock.encryptString).toHaveBeenCalledWith('saved-key')
    expect(readFileSync(keyPath(provider), 'utf8')).toBe('encrypted:saved-key')
    expect(store.read()).toBe('saved-key')
    expect(secretStoreMock.decryptString).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('creates and replaces files with mode 0600', async () => {
    const store = await loadStoreModule(provider)
    store.save('first-key')
    expect(statSync(keyPath(provider)).mode & 0o777).toBe(0o600)
    chmodSync(keyPath(provider), 0o644)
    store.save('replacement-key')
    expect(statSync(keyPath(provider)).mode & 0o777).toBe(0o600)
    expect(store.read()).toBe('replacement-key')
  })

  it('decrypts a persisted key once and caches it for subsequent dictations', async () => {
    const first = await loadStoreModule(provider)
    first.save('saved-key')
    const store = await loadStoreModule(provider)
    expect(store.read()).toBe('saved-key')
    expect(store.read()).toBe('saved-key')
    expect(secretStoreMock.decryptString).toHaveBeenCalledOnce()
  })

  it('clears its persisted secret and cache without affecting the other provider', async () => {
    const store = await loadStoreModule(provider)
    const other = await importProviderStore(provider === 'OpenAI' ? 'OpenRouter' : 'OpenAI')
    other.save('other-key')
    store.save('saved-key')
    expect(store.read()).toBe('saved-key')
    store.clear()
    expect(store.has()).toBe(false)
    expect(existsSync(keyPath(provider))).toBe(false)
    expect(() => store.read()).toThrow('not configured')
    expect(other.has()).toBe(true)
    expect(other.read()).toBe('other-key')
    expect(() => store.clear()).not.toThrow()
  })

  it('rejects empty keys without overwriting an existing secret', async () => {
    const store = await loadStoreModule(provider)
    store.save('saved-key')
    expect(() => store.save(' \n ')).toThrow(`${provider} API key is required`)
    expect(store.read()).toBe('saved-key')
    expect(readFileSync(keyPath(provider), 'utf8')).toBe('encrypted:saved-key')
  })

  it('matches the existing plaintext fallback when encryption is unavailable', async () => {
    secretStoreMock.isEncryptionAvailable.mockReturnValue(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadStoreModule(provider)
    store.save('plaintext-key')
    expect(readFileSync(keyPath(provider), 'utf8')).toBe('plaintext-key')
    expect(secretStoreMock.encryptString).not.toHaveBeenCalled()
    const reloaded = await loadStoreModule(provider)
    expect(reloaded.read()).toBe('plaintext-key')
    expect(secretStoreMock.decryptString).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls.flat().join(' ')).not.toContain('plaintext-key')
  })

  it('does not expose secret storage errors or cache failed decryptions', async () => {
    const first = await loadStoreModule(provider)
    first.save('private-key')
    const store = await loadStoreModule(provider)
    secretStoreMock.decryptString.mockImplementationOnce(() => {
      throw new Error('failed to decrypt private-key')
    })
    expect(() => store.read()).toThrow(`${provider} API key could not be decrypted`)
    expect(store.read()).toBe('private-key')
  })
})

it('preserves the legacy OpenAI encrypted JSON format', async () => {
  mkdirSync(join(tempHome, '.orca'))
  writeFileSync(
    keyPath('OpenAI'),
    JSON.stringify({ encryptedKeyBase64: Buffer.from('encrypted:legacy-key').toString('base64') })
  )
  const store = await loadStoreModule('OpenAI')
  expect(store.read()).toBe('legacy-key')
  expect(secretStoreMock.decryptString).toHaveBeenCalledWith(Buffer.from('encrypted:legacy-key'))
})
