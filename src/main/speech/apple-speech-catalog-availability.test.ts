import { afterEach, describe, expect, it, vi } from 'vitest'

const { isAppleSpeechDictationAvailable } = vi.hoisted(() => ({
  isAppleSpeechDictationAvailable: vi.fn(() => true)
}))
vi.mock('./apple-speech-helper-binary', () => ({ isAppleSpeechDictationAvailable }))

import {
  APPLE_SPEECH_MODEL_ID,
  getAvailableSpeechModelCatalog,
  getCatalogModel
} from './model-catalog'

afterEach(() => {
  isAppleSpeechDictationAvailable.mockReturnValue(true)
})

describe('Apple Speech in the model catalog', () => {
  it('describes an on-device model with nothing for Orca to download', () => {
    const manifest = getCatalogModel(APPLE_SPEECH_MODEL_ID)

    expect(manifest?.provider).toBe('apple')
    expect(manifest?.type).toBe('apple-speech')
    expect(manifest?.streaming).toBe(true)
    expect(manifest?.sizeBytes).toBeUndefined()
    expect(manifest?.downloadFiles).toBeUndefined()
  })

  it('offers it only where the helper and macOS version allow it', () => {
    expect(getAvailableSpeechModelCatalog().map((m) => m.id)).toContain(APPLE_SPEECH_MODEL_ID)

    isAppleSpeechDictationAvailable.mockReturnValue(false)
    expect(getAvailableSpeechModelCatalog().map((m) => m.id)).not.toContain(APPLE_SPEECH_MODEL_ID)
  })

  it('still resolves the manifest off macOS, so a synced setting keeps its label', () => {
    isAppleSpeechDictationAvailable.mockReturnValue(false)

    expect(getCatalogModel(APPLE_SPEECH_MODEL_ID)?.label).toBe('Apple Speech')
  })

  it('leaves every downloadable model in place', () => {
    isAppleSpeechDictationAvailable.mockReturnValue(false)
    const ids = getAvailableSpeechModelCatalog().map((m) => m.id)

    expect(ids).toContain('parakeet-tdt-0.6b-v3-int8')
    expect(ids).toContain('openai-gpt-4o-transcribe')
  })
})
