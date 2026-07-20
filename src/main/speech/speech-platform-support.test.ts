import { describe, expect, it } from 'vitest'
import type { SpeechModelManifest } from '../../shared/speech-types'
import {
  getSupportedSpeechModelSelection,
  getSupportedSpeechModels
} from './speech-platform-support'

const models: SpeechModelManifest[] = [
  {
    id: 'local',
    label: 'Local',
    provider: 'local',
    type: 'whisper',
    language: 'en',
    languages: ['en'],
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'cloud',
    label: 'Cloud',
    provider: 'openai',
    type: 'openai',
    language: 'en',
    languages: ['en'],
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'compatible',
    label: 'Compatible',
    provider: 'openai-compatible',
    type: 'openai',
    language: 'en',
    languages: ['en'],
    sampleRate: 16000,
    streaming: false
  }
]

describe('Windows ARM64 speech support', () => {
  it('offers cloud providers without a native engine, and keeps local models on supported hosts', () => {
    expect(getSupportedSpeechModels(models, 'win32', 'arm64').map((model) => model.id)).toEqual([
      'cloud',
      'compatible'
    ])
    expect(getSupportedSpeechModels(models, 'win32', 'x64').map((model) => model.id)).toEqual([
      'local',
      'cloud',
      'compatible'
    ])
  })

  it('clears unsupported persisted selections while preserving cloud selections', () => {
    expect(getSupportedSpeechModelSelection('local', models, 'win32', 'arm64')).toBe('')
    expect(getSupportedSpeechModelSelection('cloud', models, 'win32', 'arm64')).toBe('cloud')
    expect(getSupportedSpeechModelSelection('compatible', models, 'win32', 'arm64')).toBe(
      'compatible'
    )
  })
})
