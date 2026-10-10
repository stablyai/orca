import { describe, expect, it } from 'vitest'
import {
  describeProviderFailure,
  extractProviderErrorMessage,
  redactCloudSpeechSecrets
} from './cloud-speech-provider-errors'

describe('redactCloudSpeechSecrets', () => {
  it('redacts provider key shapes and auth headers', () => {
    expect(
      redactCloudSpeechSecrets(
        'bad sk_abcdef123456 gsk_abcdef123456 AIzaSyAbcdefghijklmnop Token abc.def Bearer xyz key=secret'
      )
    ).toBe('bad [redacted] [redacted] [redacted] Token [redacted] Bearer [redacted] [redacted]')
  })

  it('redacts long opaque tokens echoed by a provider', () => {
    expect(redactCloudSpeechSecrets(`Invalid key ${'a'.repeat(40)}.`)).toBe(
      'Invalid key [redacted].'
    )
  })
})

describe('extractProviderErrorMessage', () => {
  it('reads the message from each provider error shape', () => {
    expect(extractProviderErrorMessage({ error: { message: 'openai' } })).toBe('openai')
    expect(extractProviderErrorMessage({ detail: { message: 'eleven' } })).toBe('eleven')
    expect(extractProviderErrorMessage({ detail: 'mistral' })).toBe('mistral')
    expect(extractProviderErrorMessage({ message: 'soniox' })).toBe('soniox')
    expect(extractProviderErrorMessage({ err_msg: 'deepgram' })).toBe('deepgram')
    expect(extractProviderErrorMessage({})).toBeNull()
  })
})

describe('describeProviderFailure', () => {
  it('never echoes a header value that undici rejected', () => {
    const error = new TypeError(
      'Headers.append: "Bearer part1\n456789abcdef0123456789abcdef" is an invalid header value.'
    )

    expect(describeProviderFailure('Soniox', error)).toBe('API key contains invalid characters.')
  })
})
