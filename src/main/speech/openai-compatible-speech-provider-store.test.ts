import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadStoreModule() {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
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

describe('openAiCompatibleTranscriptionUrl', () => {
  it('appends the transcriptions path to a base URL and keeps a full one', async () => {
    const { openAiCompatibleTranscriptionUrl } = await loadStoreModule()
    expect(openAiCompatibleTranscriptionUrl(' https://api.groq.com/openai/v1/ ')).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions'
    )
    expect(openAiCompatibleTranscriptionUrl('https://api.mistral.ai/v1/audio/transcriptions')).toBe(
      'https://api.mistral.ai/v1/audio/transcriptions'
    )
    expect(openAiCompatibleTranscriptionUrl('http://127.0.0.1:8000/v1')).toBe(
      'http://127.0.0.1:8000/v1/audio/transcriptions'
    )
    expect(() => openAiCompatibleTranscriptionUrl('file:///etc/passwd')).toThrow()
    expect(() => openAiCompatibleTranscriptionUrl('api.groq.com')).toThrow()
    expect(() => openAiCompatibleTranscriptionUrl('https://user:pw@host.example/v1')).toThrow()
  })
})

describe('resolveOpenAiCompatibleSpeechProviderInput', () => {
  it('keeps a saved key for a blank field only while the base URL is unchanged', async () => {
    const store = await loadStoreModule()
    store.saveOpenAiCompatibleSpeechProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      apiKey: 'gsk_saved'
    })

    expect(
      store.resolveOpenAiCompatibleSpeechProviderInput({
        baseUrl: 'https://api.groq.com/openai/v1/',
        model: 'whisper-large-v3',
        apiKey: ''
      }).apiKey
    ).toBe('gsk_saved')
    expect(
      store.resolveOpenAiCompatibleSpeechProviderInput({
        baseUrl: 'https://evil.example/v1',
        model: 'whisper-large-v3',
        apiKey: ''
      }).apiKey
    ).toBe('')
  })
})
