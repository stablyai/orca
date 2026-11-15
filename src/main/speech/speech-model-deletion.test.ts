import { describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../shared/constants'
import type { VoiceSettings } from '../../shared/speech/speech-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { deleteLocalSpeechModel } from './speech-model-deletion'
const cloudModel = SPEECH_MODEL_CATALOG.find((model) => model.provider === 'openai')

function makeStore(initialVoice: VoiceSettings) {
  let voice = initialVoice
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    if (updates.voice) {
      voice = updates.voice
    }
    return { voice } as GlobalSettings
  })
  return {
    getSettings: vi.fn(() => ({ voice }) as GlobalSettings),
    updateSettings
  }
}

describe('deleteLocalSpeechModel', () => {
  it('rejects unknown and cloud models before preparing storage deletion', async () => {
    expect(cloudModel).toBeDefined()
    const store = makeStore(getDefaultVoiceSettings())
    const modelManager = { deleteModel: vi.fn(async () => {}) }
    const sttService = { prepareModelForDeletion: vi.fn(async () => {}) }

    await expect(
      deleteLocalSpeechModel({
        store,
        modelManager,
        sttService,
        modelId: 'missing-model'
      })
    ).rejects.toThrow('voice_model_unknown')
    await expect(
      deleteLocalSpeechModel({
        store,
        modelManager,
        sttService,
        modelId: cloudModel!.id
      })
    ).rejects.toThrow('voice_model_not_deletable')

    expect(sttService.prepareModelForDeletion).not.toHaveBeenCalled()
    expect(modelManager.deleteModel).not.toHaveBeenCalled()
    expect(store.updateSettings).not.toHaveBeenCalled()
  })
})
