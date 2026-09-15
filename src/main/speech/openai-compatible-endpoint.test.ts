import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../shared/constants'
import type { VoiceSettings } from '../../shared/speech-types'
import {
  readOpenAiCompatibleEndpoint,
  resolveOpenAiCompatibleUrl,
  setVoiceSettingsReader
} from './openai-compatible-endpoint'

function voice(overrides: Partial<VoiceSettings>): VoiceSettings {
  return { ...getDefaultVoiceSettings(), ...overrides }
}

describe('resolveOpenAiCompatibleUrl', () => {
  it('appends the transcription path when the URL carries none', () => {
    expect(resolveOpenAiCompatibleUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1/audio/transcriptions'
    )
    expect(resolveOpenAiCompatibleUrl('https://api.groq.com/')).toBe(
      'https://api.groq.com/v1/audio/transcriptions'
    )
  })

  it('keeps a URL that already points at an endpoint', () => {
    expect(resolveOpenAiCompatibleUrl('https://api.groq.com/openai/v1/audio/transcriptions')).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions'
    )
  })

  it('rejects empty, relative and non-http URLs', () => {
    expect(resolveOpenAiCompatibleUrl('')).toBeNull()
    expect(resolveOpenAiCompatibleUrl('   ')).toBeNull()
    expect(resolveOpenAiCompatibleUrl('api.groq.com')).toBeNull()
    expect(resolveOpenAiCompatibleUrl('file:///etc/passwd')).toBeNull()
  })
})

describe('readOpenAiCompatibleEndpoint', () => {
  afterEach(() => {
    setVoiceSettingsReader(null)
  })

  it('is null without a reader and with the default settings', () => {
    expect(readOpenAiCompatibleEndpoint()).toBeNull()
    setVoiceSettingsReader(() => getDefaultVoiceSettings())
    expect(readOpenAiCompatibleEndpoint()).toBeNull()
  })

  it('returns URL and model once both are configured', () => {
    setVoiceSettingsReader(() =>
      voice({
        openAiCompatible: {
          baseUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
          model: ' whisper-large-v3-turbo '
        }
      })
    )
    expect(readOpenAiCompatibleEndpoint()).toEqual({
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      model: 'whisper-large-v3-turbo'
    })
  })

  it('keeps the catalog model when only the URL is set', () => {
    setVoiceSettingsReader(() =>
      voice({ openAiCompatible: { baseUrl: 'http://127.0.0.1:8080', model: '' } })
    )
    expect(readOpenAiCompatibleEndpoint()).toEqual({
      url: 'http://127.0.0.1:8080/v1/audio/transcriptions',
      model: null
    })
  })

  it('ignores a model without a URL, so dictation still goes to OpenAI', () => {
    setVoiceSettingsReader(() =>
      voice({ openAiCompatible: { baseUrl: '', model: 'whisper-large-v3' } })
    )
    expect(readOpenAiCompatibleEndpoint()).toBeNull()
  })
})
