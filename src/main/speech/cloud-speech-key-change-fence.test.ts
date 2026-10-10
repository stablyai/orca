import { describe, expect, it, vi } from 'vitest'
import {
  beginCloudSpeechKeyChange,
  saveCloudSpeechApiKeyIfLatest,
  SUPERSEDED_CLOUD_SPEECH_KEY_SAVE_MESSAGE
} from './cloud-speech-key-change-fence'

describe('cloud speech key change fence', () => {
  it('saves when no other change started while verifying', async () => {
    const save = vi.fn()

    await saveCloudSpeechApiKeyIfLatest('deepgram', async () => {}, save)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('drops a save superseded by a change that started during verification', async () => {
    const save = vi.fn()
    let finishVerify: () => void = () => {}
    const saving = saveCloudSpeechApiKeyIfLatest(
      'soniox',
      () =>
        new Promise<void>((resolve) => {
          finishVerify = resolve
        }),
      save
    )

    beginCloudSpeechKeyChange('soniox')
    finishVerify()

    await expect(saving).rejects.toThrow(SUPERSEDED_CLOUD_SPEECH_KEY_SAVE_MESSAGE)
    expect(save).not.toHaveBeenCalled()
  })

  it('keeps providers independent', () => {
    const isLatest = beginCloudSpeechKeyChange('gemini')
    beginCloudSpeechKeyChange('mistral')

    expect(isLatest()).toBe(true)
  })
})
