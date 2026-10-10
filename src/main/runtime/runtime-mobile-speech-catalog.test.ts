import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: () => ({ getModelStates: async () => [] }),
  getSpeechSttService: () => ({})
}))

import { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'

describe('RuntimeMobileSpeechCatalog', () => {
  it('keeps speech.models.list to the local and OpenAI rows shipped phones understand', async () => {
    const store = { getSettings: () => ({ voice: { enabled: true, sttModel: '' } }) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: list() reads only settings.
    const catalog = new RuntimeMobileSpeechCatalog(() => store as unknown as RuntimeStore)

    const state = await catalog.list()

    expect(new Set(state.models.map((model) => model.provider))).toEqual(
      new Set(['local', 'openai'])
    )
    expect(state.models.some((model) => model.id === 'soniox-stt-rt-v5')).toBe(false)
  })

  it('accepts a new cloud model id in dictation setup', async () => {
    const updateSettings = vi.fn()
    const store = {
      getSettings: () => ({ voice: { enabled: true, sttModel: '' } }),
      updateSettings
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: configure() reads and writes only settings.
    const catalog = new RuntimeMobileSpeechCatalog(() => store as unknown as RuntimeStore)

    await catalog.configure({ modelId: 'elevenlabs-scribe-v2-realtime' })

    expect(updateSettings).toHaveBeenCalledWith(
      { voice: expect.objectContaining({ sttModel: 'elevenlabs-scribe-v2-realtime' }) },
      { notifyListeners: true }
    )
    await expect(catalog.download('deepgram-nova-3')).rejects.toThrow(
      'voice_model_not_downloadable'
    )
  })
})
