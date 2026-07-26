import { describe, expect, it } from 'vitest'
import {
  OpenAiTranscriptionSession,
  sanitizeOpenAiTranscriptionErrorMessage
} from './openai-transcription-client'

describe('sanitizeOpenAiTranscriptionErrorMessage', () => {
  it('does not expose the invalid OpenAI API key echoed by the provider', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Incorrect API key provided: fsdfdsfsdf. You can find your API key at https://platform.openai.com/account/api-keys.'
      )
    ).toBe('Incorrect OpenAI API key provided.')
  })

  it('redacts API keys and bearer tokens from other provider errors', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Request failed for sk-testSecret123 with Authorization: Bearer token-value_123'
      )
    ).toBe('Request failed for [redacted] with Authorization: Bearer [redacted]')
  })

  it('retains one growable sample buffer for adversarial one-sample feeds', () => {
    const session = new OpenAiTranscriptionSession('openai-gpt-4o-mini-transcribe', () => 'key')
    const sample = new Float32Array([0.25])

    for (let index = 0; index < 100_000; index += 1) {
      session.feedAudio(sample, 16_000)
    }

    expect(Reflect.get(session, 'sampleCount')).toBe(100_000)
    expect(Reflect.get(session, 'samples')).toBeInstanceOf(Float32Array)
  })
})
