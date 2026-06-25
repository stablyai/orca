import { describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../shared/constants'
import type { VoiceSettings } from '../../shared/speech-types'
import type { GlobalSettings } from '../../shared/types'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { deleteLocalSpeechModel } from './speech-model-deletion'

const localModel = SPEECH_MODEL_CATALOG.find((model) => model.provider === 'local')
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
  it('clears the selected local model after deletion succeeds', async () => {
    expect(localModel).toBeDefined()
    const calls: string[] = []
    const voice = { ...getDefaultVoiceSettings(), enabled: true, sttModel: localModel!.id }
    const store = makeStore(voice)
    const modelManager = {
      deleteModel: vi.fn(async () => {
        calls.push('delete')
      })
    }
    const sttService = {
      prepareModelForDeletion: vi.fn(async () => {
        calls.push('prepare')
      })
    }

    await deleteLocalSpeechModel({
      store,
      modelManager,
      sttService,
      modelId: localModel!.id
    })

    expect(calls).toEqual(['prepare', 'delete'])
    expect(store.updateSettings).toHaveBeenCalledWith(
      {
        voice: {
          ...voice,
          sttModel: ''
        }
      },
      { notifyListeners: true }
    )
  })

  it('does not clear selection when another client selected a newer model', async () => {
    expect(localModel).toBeDefined()
    const voice = { ...getDefaultVoiceSettings(), enabled: true, sttModel: localModel!.id }
    const store = makeStore(voice)
    const modelManager = {
      deleteModel: vi.fn(async () => {
        store.updateSettings({ voice: { ...voice, sttModel: 'newer-model' } })
      })
    }
    const sttService = { prepareModelForDeletion: vi.fn(async () => {}) }

    await deleteLocalSpeechModel({
      store,
      modelManager,
      sttService,
      modelId: localModel!.id
    })

    expect(store.updateSettings).toHaveBeenCalledTimes(1)
    expect(store.updateSettings).toHaveBeenCalledWith({
      voice: { ...voice, sttModel: 'newer-model' }
    })
  })

  it('leaves settings untouched when deletion fails', async () => {
    expect(localModel).toBeDefined()
    const store = makeStore({ ...getDefaultVoiceSettings(), sttModel: localModel!.id })
    const modelManager = {
      deleteModel: vi.fn(async () => {
        throw new Error('permission denied')
      })
    }
    const sttService = { prepareModelForDeletion: vi.fn(async () => {}) }

    await expect(
      deleteLocalSpeechModel({
        store,
        modelManager,
        sttService,
        modelId: localModel!.id
      })
    ).rejects.toThrow('permission denied')

    expect(store.updateSettings).not.toHaveBeenCalled()
  })

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
