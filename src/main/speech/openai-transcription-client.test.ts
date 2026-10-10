import { describe, expect, it } from 'vitest'
import { sanitizeOpenAiTranscriptionErrorMessage } from './openai-transcription-client'

describe('sanitizeOpenAiTranscriptionErrorMessage', () => {
  it('does not expose the invalid OpenAI API key echoed by the provider', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'OpenAI',
        'Incorrect API key provided: fsdfdsfsdf. You can find your API key at https://platform.openai.com/account/api-keys.'
      )
    ).toBe('Incorrect OpenAI API key provided.')
  })

  it('redacts API keys and bearer tokens from other provider errors', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'OpenAI',
        'Request failed for sk-testSecret123 with Authorization: Bearer token-value_123'
      )
    ).toBe('Request failed for [redacted] with Authorization: Bearer [redacted]')
  })

  it('names the OpenAI-compatible host whose key was rejected', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage('Groq', 'Incorrect API key provided: gsk_abc.')
    ).toBe('Incorrect Groq API key provided.')
    expect(sanitizeOpenAiTranscriptionErrorMessage('Groq', '   ')).toBe(
      'Groq transcription request failed'
    )
  })
})
