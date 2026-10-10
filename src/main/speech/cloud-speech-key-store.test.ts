import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^enc:/, '')),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  isEncryptionAvailable: vi.fn(() => true)
}))

let tempHome = ''

async function loadStoreModule() {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({ ...safeStorageMock, describeProtectionGap: () => null })
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./cloud-speech-key-store')
}

function orcaPath(name: string): string {
  return join(tempHome, '.orca', name)
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-cloud-key-store-'))
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
})

describe('cloud speech key store', () => {
  it('stores each provider in its own encrypted file with a non-secret hint', async () => {
    const store = await loadStoreModule()

    store.saveCloudSpeechApiKey('soniox', '  soniox-key-a1b2  ')

    expect(readFileSync(orcaPath('speech-soniox-token.enc'), 'utf8')).toBe('enc:soniox-key-a1b2')
    expect(readFileSync(orcaPath('speech-soniox-token.hint'), 'utf8')).toBe('…a1b2')
    expect(store.hasCloudSpeechApiKey('soniox')).toBe(true)
    expect(store.hasCloudSpeechApiKey('deepgram')).toBe(false)
    expect(store.getCloudSpeechKeyStatus('soniox')).toMatchObject({
      providerId: 'soniox',
      configured: true,
      hint: '…a1b2'
    })
  })

  it('keeps the legacy OpenAI filename so existing keys stay configured', async () => {
    mkdirSync(join(tempHome, '.orca'), { recursive: true })
    writeFileSync(orcaPath('openai-speech-token.enc'), 'enc:sk-legacy-wxyz')
    const store = await loadStoreModule()

    expect(store.hasCloudSpeechApiKey('openai')).toBe(true)
    expect(store.getCloudSpeechApiKeyHint('openai')).toBeNull()
    expect(store.readCloudSpeechApiKey('openai')).toBe('sk-legacy-wxyz')
    // Why: the first decrypt backfills the hint so later listings show it without decrypting.
    expect(store.getCloudSpeechApiKeyHint('openai')).toBe('…wxyz')
  })

  it('lists every provider without decrypting', async () => {
    const store = await loadStoreModule()
    store.saveCloudSpeechApiKey('groq', 'gsk_1234')
    safeStorageMock.decryptString.mockClear()

    const statuses = store.getAllCloudSpeechKeyStatuses()

    expect(statuses.map((status) => status.providerId)).toEqual([
      'soniox',
      'elevenlabs',
      'deepgram',
      'gemini',
      'openai',
      'groq',
      'mistral'
    ])
    expect(statuses.find((status) => status.providerId === 'groq')?.hint).toBe('…1234')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('clears the key, its hint and the cached value', async () => {
    const store = await loadStoreModule()
    store.saveCloudSpeechApiKey('mistral', 'mistral-key')

    store.clearCloudSpeechApiKey('mistral')

    expect(existsSync(orcaPath('speech-mistral-token.enc'))).toBe(false)
    expect(existsSync(orcaPath('speech-mistral-token.hint'))).toBe(false)
    expect(() => store.readCloudSpeechApiKey('mistral')).toThrow(
      'Mistral API key is not configured'
    )
  })

  it('rejects an empty key', async () => {
    const store = await loadStoreModule()

    expect(() => store.saveCloudSpeechApiKey('gemini', '   ')).toThrow(
      'Google Gemini API key is required'
    )
  })

  it('rejects a key with an embedded line break', async () => {
    const store = await loadStoreModule()

    expect(() => store.saveCloudSpeechApiKey('deepgram', 'abc123\r\n456def')).toThrow(
      'API key contains spaces, line breaks, or other invalid characters.'
    )
  })
})
