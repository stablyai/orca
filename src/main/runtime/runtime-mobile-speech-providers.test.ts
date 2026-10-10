import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSpeechProviderId } from '../../shared/cloud-speech-providers'
import type { RuntimeStore } from './runtime-store-contract'

const keyStore = vi.hoisted(() => ({
  keys: new Map<string, string>(),
  saveCloudSpeechApiKey: vi.fn(),
  clearCloudSpeechApiKey: vi.fn()
}))
const verifyCloudSpeechApiKeyMock = vi.hoisted(() => vi.fn())

vi.mock('../speech/cloud-speech-key-store', async () => {
  const { beginCloudSpeechKeyChange } = await import('../speech/cloud-speech-key-change-fence')
  return {
    hasCloudSpeechApiKey: (id: string) => keyStore.keys.has(id),
    getCloudSpeechApiKeyHint: (id: string) => {
      const key = keyStore.keys.get(id)
      return key ? `…${key.slice(-4)}` : null
    },
    readCloudSpeechApiKey: (id: string) => keyStore.keys.get(id) ?? '',
    saveCloudSpeechApiKey: (id: CloudSpeechProviderId, key: string) => {
      beginCloudSpeechKeyChange(id)
      keyStore.saveCloudSpeechApiKey(id, key)
      keyStore.keys.set(id, key)
    },
    clearCloudSpeechApiKey: (id: CloudSpeechProviderId) => {
      beginCloudSpeechKeyChange(id)
      keyStore.clearCloudSpeechApiKey(id)
      keyStore.keys.delete(id)
    }
  }
})
vi.mock('../speech/cloud-speech-key-verification', () => ({
  verifyCloudSpeechApiKey: verifyCloudSpeechApiKeyMock
}))
vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: () => ({
    getModelStates: async () => [{ id: 'parakeet-tdt-0.6b-v3-int8', status: 'ready' }]
  })
}))

import { RuntimeMobileSpeechProviders } from './runtime-mobile-speech-providers'

function createStore(voice: Record<string, unknown> = {}) {
  let settings: { voice?: Record<string, unknown> } = {
    voice: { enabled: true, sttModel: 'soniox-stt-rt-v5', dictationMode: 'hold', ...voice }
  }
  const updateSettings = vi.fn((updates: { voice?: Record<string, unknown> }) => {
    settings = { ...settings, ...updates }
  })
  const store = { getSettings: () => settings, updateSettings }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The providers owner reads only settings accessors.
  const providers = new RuntimeMobileSpeechProviders(() => store as unknown as RuntimeStore)
  return { providers, updateSettings, getVoice: () => settings.voice }
}

beforeEach(() => {
  keyStore.keys.clear()
  keyStore.saveCloudSpeechApiKey.mockClear()
  keyStore.clearCloudSpeechApiKey.mockClear()
  verifyCloudSpeechApiKeyMock.mockReset()
})

describe('RuntimeMobileSpeechProviders', () => {
  it('lists on-device first, then cloud providers in shared order with key hints', async () => {
    keyStore.keys.set('soniox', 'secret-a1b2')
    const { providers } = createStore()

    const state = await providers.list()

    expect(state).toMatchObject({
      enabled: true,
      selectedModelId: 'soniox-stt-rt-v5',
      dictationMode: 'hold',
      language: 'auto'
    })
    expect(state.providers.map((provider) => provider.id)).toEqual([
      'local',
      'soniox',
      'elevenlabs',
      'deepgram',
      'gemini',
      'openai',
      'groq',
      'mistral'
    ])
    expect(state.providers[0]).toMatchObject({ kind: 'local', label: 'On-device', keyHint: null })
    expect(
      state.providers[0].models.find((m) => m.id === 'parakeet-tdt-0.6b-v3-int8')?.status
    ).toBe('ready')
    const soniox = state.providers[1]
    expect(soniox).toMatchObject({ keyConfigured: true, keyHint: '…a1b2' })
    expect(soniox.models[0]).toMatchObject({ id: 'soniox-stt-rt-v5', realtime: true })
    expect(JSON.stringify(state)).not.toContain('secret-a1b2')
  })

  it('verifies before saving and refuses a rejected key', async () => {
    verifyCloudSpeechApiKeyMock.mockResolvedValue({
      ok: false,
      message: 'Soniox rejected this API key (401).'
    })
    const { providers } = createStore()

    await expect(
      providers.saveKey({ providerId: 'soniox', apiKey: 'bad', verify: true })
    ).rejects.toThrow('Soniox rejected this API key (401).')
    expect(keyStore.saveCloudSpeechApiKey).not.toHaveBeenCalled()
  })

  it('verifies a key when the caller omits the verify flag', async () => {
    verifyCloudSpeechApiKeyMock.mockResolvedValue({ ok: false, message: 'Groq rejected it.' })
    const { providers } = createStore()

    await expect(providers.saveKey({ providerId: 'groq', apiKey: 'gsk_typo' })).rejects.toThrow(
      'Groq rejected it.'
    )
    expect(keyStore.saveCloudSpeechApiKey).not.toHaveBeenCalled()
  })

  it('saves a verified key and reports only its hint', async () => {
    verifyCloudSpeechApiKeyMock.mockResolvedValue({ ok: true, message: null })
    const { providers } = createStore()

    const state = await providers.saveKey({
      providerId: 'groq',
      apiKey: ' gsk_9876 ',
      verify: true
    })

    expect(keyStore.saveCloudSpeechApiKey).toHaveBeenCalledWith('groq', 'gsk_9876')
    expect(state.providers.find((provider) => provider.id === 'groq')).toMatchObject({
      keyConfigured: true,
      keyHint: '…9876'
    })
  })

  it('discards a verified save when the key is cleared while verifying', async () => {
    let finishVerify: (result: { ok: boolean; message: null }) => void = () => {}
    verifyCloudSpeechApiKeyMock.mockReturnValue(
      new Promise((resolve) => {
        finishVerify = resolve
      })
    )
    const { providers } = createStore()

    const saving = providers.saveKey({ providerId: 'groq', apiKey: 'gsk_old1' })
    await providers.clearKey({ providerId: 'groq' })
    finishVerify({ ok: true, message: null })

    await expect(saving).rejects.toThrow(
      "A newer change to this provider's key was made; this save was discarded."
    )
    expect(keyStore.saveCloudSpeechApiKey).not.toHaveBeenCalled()
    expect(keyStore.keys.has('groq')).toBe(false)
  })

  it('keeps the newer of two overlapping saves even when the older verifies last', async () => {
    const pending: ((result: { ok: boolean; message: null }) => void)[] = []
    verifyCloudSpeechApiKeyMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve)
        })
    )
    const { providers } = createStore()

    const saveA = providers.saveKey({ providerId: 'groq', apiKey: 'gsk_aaaa' })
    const saveB = providers.saveKey({ providerId: 'groq', apiKey: 'gsk_bbbb' })
    pending[1]({ ok: true, message: null })
    await saveB
    pending[0]({ ok: true, message: null })

    await expect(saveA).rejects.toThrow('this save was discarded')
    expect(keyStore.keys.get('groq')).toBe('gsk_bbbb')
  })

  it('discards the older save when it verifies first', async () => {
    const pending: ((result: { ok: boolean; message: null }) => void)[] = []
    verifyCloudSpeechApiKeyMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve)
        })
    )
    const { providers } = createStore()

    const saveA = providers.saveKey({ providerId: 'groq', apiKey: 'gsk_aaaa' })
    const saveB = providers.saveKey({ providerId: 'groq', apiKey: 'gsk_bbbb' })
    pending[0]({ ok: true, message: null })
    await expect(saveA).rejects.toThrow('this save was discarded')
    pending[1]({ ok: true, message: null })
    await saveB

    expect(keyStore.saveCloudSpeechApiKey).toHaveBeenCalledTimes(1)
    expect(keyStore.keys.get('groq')).toBe('gsk_bbbb')
  })

  it('rejects unknown providers', async () => {
    const { providers } = createStore()

    await expect(providers.clearKey({ providerId: 'local' })).rejects.toThrow(
      'voice_provider_unknown'
    )
  })

  it('keeps the selected model when its provider key is cleared', async () => {
    keyStore.keys.set('soniox', 'secret-a1b2')
    const { providers } = createStore()

    const state = await providers.clearKey({ providerId: 'soniox' })

    expect(state.selectedModelId).toBe('soniox-stt-rt-v5')
    expect(state.providers[1]).toMatchObject({ keyConfigured: false, keyHint: null })
  })

  it('tests the saved key and reports a missing one without a request', async () => {
    const { providers } = createStore()

    await expect(providers.testKey({ providerId: 'deepgram' })).resolves.toEqual({
      ok: false,
      message: 'No API key saved.'
    })
    expect(verifyCloudSpeechApiKeyMock).not.toHaveBeenCalled()

    keyStore.keys.set('deepgram', 'dg-key')
    verifyCloudSpeechApiKeyMock.mockResolvedValue({ ok: true, message: null })
    await expect(providers.testKey({ providerId: 'deepgram' })).resolves.toEqual({
      ok: true,
      message: null
    })
    expect(verifyCloudSpeechApiKeyMock).toHaveBeenCalledWith('deepgram', 'dg-key')
  })

  it('writes a known transcription language and rejects unknown codes', async () => {
    const { providers, getVoice } = createStore()

    const state = await providers.configure({ language: 'uk' })

    expect(state.language).toBe('uk')
    expect(getVoice()?.transcriptionLanguage).toBe('uk')
    await expect(providers.configure({ language: 'xx' })).rejects.toThrow('voice_language_unknown')
  })
})
