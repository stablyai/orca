import { describe, expect, it } from 'vitest'
import type { SpeechModelManifest } from '../../shared/speech-types'
import {
  assertLocalSpeechRecognitionSupported,
  getSupportedSpeechModelSelection,
  getSupportedSpeechModels,
  LOCAL_SPEECH_UNAVAILABLE_ERROR_CODE,
  supportsLocalSpeechRecognition
} from './speech-platform-support'

const models = [
  { id: 'local', provider: 'local' },
  { id: 'cloud', provider: 'openai' }
] as SpeechModelManifest[]

describe('Windows ARM64 speech support', () => {
  it('does not advertise local speech models without a native addon', () => {
    expect(supportsLocalSpeechRecognition('win32', 'arm64')).toBe(false)
    expect(getSupportedSpeechModels(models, 'win32', 'arm64')).toEqual([models[1]])
  })

  it('preserves local speech models on supported targets', () => {
    expect(getSupportedSpeechModels(models, 'win32', 'x64')).toBe(models)
    expect(getSupportedSpeechModels(models, 'darwin', 'arm64')).toBe(models)
  })

  it('clears unsupported persisted selections', () => {
    expect(getSupportedSpeechModelSelection(models[0].id, models, 'win32', 'arm64')).toBe('')
    expect(getSupportedSpeechModelSelection(models[1].id, models, 'win32', 'arm64')).toBe(
      models[1].id
    )
  })

  it('uses one stable error code for unavailable local speech', () => {
    expect(() => assertLocalSpeechRecognitionSupported('win32', 'arm64')).toThrow(
      LOCAL_SPEECH_UNAVAILABLE_ERROR_CODE
    )
    expect(() => assertLocalSpeechRecognitionSupported('win32', 'x64')).not.toThrow()
  })
})
