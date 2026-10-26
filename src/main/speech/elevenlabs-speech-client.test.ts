import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listElevenLabsVoices,
  synthesizeElevenLabsSpeech,
  validateElevenLabsSpeechRequest
} from './elevenlabs-speech-client'
import type { ElevenLabsSpeechRequest } from '../../shared/speech-types'

vi.mock('./elevenlabs-api-key-store', () => ({
  readElevenLabsSpeechApiKey: () => 'test-only-key'
}))

afterEach(() => vi.unstubAllGlobals())

const input: ElevenLabsSpeechRequest = {
  requestId: 'test-1',
  text: '안녕하세요.',
  voiceId: 'test_voice',
  modelId: 'eleven_flash_v2_5'
}

describe('ElevenLabs speech requests', () => {
  it('rejects paths, arbitrary models and unbounded input before requesting audio', () => {
    for (const update of [
      { voiceId: '../secret' },
      { voiceId: 'https://example.com' },
      { modelId: 'unknown' },
      { text: 'x'.repeat(501) },
      { requestId: '../request' }
    ]) {
      expect(() => validateElevenLabsSpeechRequest({ ...input, ...update })).toThrow(
        'elevenlabs_invalid_request'
      )
    }
  })

  it('authenticates to a fixed endpoint and applies calm speech settings', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    vi.stubGlobal('fetch', fetchMock)
    const result = await synthesizeElevenLabsSpeech(input, new AbortController().signal)
    expect(result).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/text-to-speech/test_voice/stream?output_format=mp3_44100_128',
      expect.objectContaining({
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': 'test-only-key' },
        body: JSON.stringify({
          text: input.text,
          model_id: input.modelId,
          voice_settings: {
            stability: 0.7,
            similarity_boost: 0.75,
            style: 0,
            speed: 0.95,
            use_speaker_boost: true
          }
        })
      })
    )
  })

  it('discards vendor error content and never retries charged requests', async () => {
    const fetchMock = vi.fn(async () => new Response('test-only-sensitive-text', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(synthesizeElevenLabsSpeech(input, new AbortController().signal)).rejects.toThrow(
      /^elevenlabs_http_401$/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns only validated voice identifiers and names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          voices: [
            { voice_id: '../bad', name: 'bad' },
            { voice_id: 'voice_1', name: 'Calm', metadata: 'not-needed' }
          ]
        })
      )
    )
    expect(await listElevenLabsVoices(new AbortController().signal)).toEqual([
      { id: 'voice_1', name: 'Calm' }
    ])
  })

  it('caps the audio held in memory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)))
    )
    await expect(synthesizeElevenLabsSpeech(input, new AbortController().signal)).rejects.toThrow(
      'elevenlabs_response_failed'
    )
  })

  it('delivers PCM chunks before the response ends without buffering another copy', async () => {
    const body = new TransformStream<Uint8Array, Uint8Array>()
    const writer = body.writable.getWriter()
    const fetchMock = vi.fn(async () => new Response(body.readable))
    vi.stubGlobal('fetch', fetchMock)
    const chunk = vi.fn()
    const result = synthesizeElevenLabsSpeech(input, new AbortController().signal, chunk)
    await writer.write(new Uint8Array([1, 2]))
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledWith(new Uint8Array([1, 2])))
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/text-to-speech/test_voice/stream?output_format=pcm_24000',
      expect.anything()
    )
    await writer.write(new Uint8Array([3, 4]))
    await writer.close()
    expect(await result).toHaveLength(0)
    expect(chunk).toHaveBeenCalledTimes(2)
  })
})
