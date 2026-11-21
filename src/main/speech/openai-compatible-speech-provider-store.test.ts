import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadStoreModule() {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secure-storage/secret-store')
  setSecretStore({
    decryptString: (value: Buffer) => value.toString('utf8'),
    encryptString: (value: string) => Buffer.from(value),
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null
  })
  return import('./openai-compatible-speech-provider-store')
}

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'orca-compatible-speech-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

describe('resolveOpenAiCompatibleSpeechProviderInput', () => {
  it('keeps a saved key for a blank field only while the base URL is unchanged', async () => {
    const store = await loadStoreModule()
    await store.saveOpenAiCompatibleSpeechProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      apiKey: 'gsk_saved'
    })

    expect(
      (
        await store.resolveOpenAiCompatibleSpeechProviderInput({
          baseUrl: 'https://api.groq.com/openai/v1/',
          model: 'whisper-large-v3',
          apiKey: ''
        })
      ).apiKey
    ).toBe('gsk_saved')
    expect(
      (
        await store.resolveOpenAiCompatibleSpeechProviderInput({
          baseUrl: 'https://evil.example/v1',
          model: 'whisper-large-v3',
          apiKey: ''
        })
      ).apiKey
    ).toBe('')
  })
})
