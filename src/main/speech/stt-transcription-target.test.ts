import { beforeEach, describe, expect, it, vi } from 'vitest'

const { customEndpointState, openAiKeyState } = vi.hoisted(() => ({
  customEndpointState: {
    config: null as { baseUrl: string; model: string } | null,
    apiKey: null as string | null
  },
  openAiKeyState: { value: 'sk-test' }
}))

vi.mock('./custom-stt-endpoint-store', () => ({
  readCustomSttEndpointConfig: () => customEndpointState.config,
  readCustomSttEndpointApiKey: () => customEndpointState.apiKey,
  resolveCustomSttTranscriptionUrl: (baseUrl: string) => `${baseUrl}/audio/transcriptions`
}))

vi.mock('./openai-api-key-store', () => ({
  readOpenAiSpeechApiKey: () => openAiKeyState.value
}))

import { resolveTranscriptionTarget } from './stt-transcription-target'

describe('resolveTranscriptionTarget', () => {
  beforeEach(() => {
    customEndpointState.config = null
    customEndpointState.apiKey = null
    openAiKeyState.value = 'sk-test'
  })

  it('resolves the built-in OpenAI cloud target', () => {
    expect(resolveTranscriptionTarget('openai-gpt-4o-transcribe')).toEqual({
      url: 'https://api.openai.com/v1/audio/transcriptions',
      apiKey: 'sk-test',
      apiModel: 'gpt-4o-transcribe'
    })
  })

  it('resolves the custom endpoint with an optional token', () => {
    customEndpointState.config = { baseUrl: 'http://127.0.0.1:8090/v1', model: 'large-v3' }
    customEndpointState.apiKey = null

    expect(resolveTranscriptionTarget('custom-openai-compatible')).toEqual({
      url: 'http://127.0.0.1:8090/v1/audio/transcriptions',
      apiKey: null,
      apiModel: 'large-v3'
    })
  })

  it('throws when the custom endpoint is selected but unconfigured', () => {
    customEndpointState.config = null
    expect(() => resolveTranscriptionTarget('custom-openai-compatible')).toThrow(/not configured/)
  })

  it('throws for an unknown model id', () => {
    expect(() => resolveTranscriptionTarget('nope')).toThrow(/Unknown OpenAI transcription model/)
  })
})
