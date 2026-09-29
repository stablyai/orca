import { afterEach, describe, expect, it, vi } from 'vitest'
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
})

afterEach(() => vi.unstubAllGlobals())

it('keeps OpenAI multipart transcription working with the shared audio encoder', async () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: ' hello ' }))
  vi.stubGlobal('fetch', fetchMock)
  const session = new OpenAiTranscriptionSession(
    'openai-gpt-4o-mini-transcribe',
    () => 'openai-key'
  )
  session.feedAudio(new Float32Array([0, 1, -1]), 16000)
  expect(await session.finish()).toBe('hello')
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
  expect(init?.headers).toEqual({ Authorization: 'Bearer openai-key' })
  if (!(init?.body instanceof FormData)) {
    throw new Error('Expected multipart form')
  }
  expect(init.body.get('model')).toBe('gpt-4o-mini-transcribe')
  expect(init.body.get('response_format')).toBe('json')
  const file = init.body.get('file')
  if (!(file instanceof Blob)) {
    throw new Error('Expected WAV file')
  }
  const wav = Buffer.from(await file.arrayBuffer())
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
  expect(wav.readUInt32LE(24)).toBe(16000)
  expect(wav.readInt16LE(48)).toBe(-32768)
})
