import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveOpenAiTranscriptionUrl,
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
})

describe('resolveOpenAiTranscriptionUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to the hosted OpenAI endpoint', () => {
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'https://api.openai.com/v1/audio/transcriptions'
    )
  })

  it('honours OPENAI_BASE_URL for a local gateway without /v1', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:20128')
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'http://127.0.0.1:20128/v1/audio/transcriptions'
    )
  })

  it('does not double /v1 when override already includes /v1', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:20128/v1')
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'http://127.0.0.1:20128/v1/audio/transcriptions'
    )
  })

  it('normalises trailing slashes and surrounding whitespace', () => {
    vi.stubEnv('OPENAI_BASE_URL', ' https://my-gw.example/v1/ ')
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'https://my-gw.example/v1/audio/transcriptions'
    )
  })

  it('treats blank env as unset', () => {
    vi.stubEnv('OPENAI_BASE_URL', '   ')
    expect(resolveOpenAiTranscriptionUrl()).toBe(
      'https://api.openai.com/v1/audio/transcriptions'
    )
  })

  it('prefers an explicit base URL over the environment', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:20128')
    expect(resolveOpenAiTranscriptionUrl('https://gateway.internal')).toBe(
      'https://gateway.internal/v1/audio/transcriptions'
    )
  })
})
