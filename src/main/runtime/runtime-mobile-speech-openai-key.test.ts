import { beforeEach, describe, expect, it, vi } from 'vitest'

const keyStore = vi.hoisted(() => {
  const store: { key: string | null } = { key: null }
  return store
})

vi.mock('../speech/openai-api-key-store', () => ({
  hasOpenAiSpeechApiKey: () => keyStore.key !== null,
  getOpenAiSpeechApiKeyProtection: () => (keyStore.key === null ? null : 'sealed'),
  saveOpenAiSpeechApiKey: (apiKey: string) => {
    keyStore.key = apiKey
  },
  clearOpenAiSpeechApiKey: () => {
    keyStore.key = null
  }
}))

const { RuntimeMobileSpeechCatalog } = await import('./runtime-mobile-speech-catalog')
const { OpenAiSpeechKeySet } = await import('../../shared/rpc-contract/speech-params')

beforeEach(() => {
  keyStore.key = null
})

// A headless host has no desktop Settings, so the key for cloud dictation is set over RPC.
describe('the OpenAI speech key on the host that transcribes', () => {
  it('saves, reports and clears the key through the host secret store', () => {
    const catalog = new RuntimeMobileSpeechCatalog(() => null)
    expect(catalog.openAiKeyStatus()).toEqual({ configured: false, protection: null })
    expect(catalog.setOpenAiKey('sk-test')).toEqual({ configured: true, protection: 'sealed' })
    expect(keyStore.key).toBe('sk-test')
    expect(catalog.clearOpenAiKey()).toEqual({ configured: false, protection: null })
  })

  it('accepts a trimmed key and refuses an empty one', () => {
    expect(OpenAiSpeechKeySet.parse({ apiKey: '  sk-test\n' })).toEqual({ apiKey: 'sk-test' })
    expect(OpenAiSpeechKeySet.safeParse({ apiKey: '   ' }).success).toBe(false)
  })
})
