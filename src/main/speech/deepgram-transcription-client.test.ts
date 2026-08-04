import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEEPGRAM_TRANSCRIPTION_MODEL_BY_ID,
  DeepgramTranscriptionSession
} from './deepgram-transcription-client'

describe('DeepgramTranscriptionSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('sends recorded audio to Nova-3 with a Token credential', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: 'Deepgram 전사' }] }] }
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const session = new DeepgramTranscriptionSession('deepgram-nova-3', () => 'dg-secret')

    session.feedAudio(new Float32Array([0, 0.5, -0.5]), 16_000)

    await expect(session.finish()).resolves.toBe('Deepgram 전사')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepgram.com/v1/listen?model=nova-3&language=ko&smart_format=true',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Token dg-secret',
          'Content-Type': 'audio/wav'
        })
      })
    )
  })

  it('uses the API model mapped from the selected catalog model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: { channels: [{ alternatives: [{ transcript: 'Deepgram 전사' }] }] }
        })
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    DEEPGRAM_TRANSCRIPTION_MODEL_BY_ID['deepgram-future'] = 'future-model'
    const session = new DeepgramTranscriptionSession('deepgram-future', () => 'dg-secret')
    session.feedAudio(new Float32Array([0]), 16_000)

    try {
      await expect(session.finish()).resolves.toBe('Deepgram 전사')
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.deepgram.com/v1/listen?model=future-model&language=ko&smart_format=true',
        expect.anything()
      )
    } finally {
      delete DEEPGRAM_TRANSCRIPTION_MODEL_BY_ID['deepgram-future']
    }
  })

  it('rejects an unknown Deepgram model before sending a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const session = new DeepgramTranscriptionSession('deepgram-nova-9', () => 'dg-secret')
    session.feedAudio(new Float32Array([0]), 16_000)

    await expect(session.finish()).rejects.toThrow(
      'Unknown Deepgram transcription model: deepgram-nova-9'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('limits a single dictation to ten minutes of audio', () => {
    const session = new DeepgramTranscriptionSession('deepgram-nova-3', () => 'dg-secret')

    expect(() => session.feedAudio(new Float32Array(16_000 * 601), 16_000)).toThrow(
      'Cloud transcription is limited to 10 minutes per dictation'
    )
  })

  it('rejects a response without a transcript', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    const session = new DeepgramTranscriptionSession('deepgram-nova-3', () => 'dg-secret')
    session.feedAudio(new Float32Array([0]), 16_000)

    await expect(session.finish()).rejects.toThrow(
      'Deepgram transcription response did not include text'
    )
  })
})

describe('DeepgramTranscriptionSession security boundaries', () => {
  it('uses a generic error instead of a Deepgram server error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ err_msg: 'Upstream failure for Token dg-secret-123' }), {
          status: 401,
          statusText: 'Sensitive upstream error'
        })
      )
    )
    const session = new DeepgramTranscriptionSession('deepgram-nova-3', () => 'dg-secret')
    session.feedAudio(new Float32Array([0]), 16_000)

    const error = await session.finish().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Deepgram transcription failed')
  })

  it('aborts a request that exceeds the transcription timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      })
    )
    const session = new DeepgramTranscriptionSession('deepgram-nova-3', () => 'dg-secret')
    session.feedAudio(new Float32Array([0]), 16_000)

    let outcome: unknown
    void session.finish().then(
      () => {
        outcome = 'resolved'
      },
      (error: unknown) => {
        outcome = error
      }
    )
    await vi.advanceTimersByTimeAsync(60_000)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('Deepgram transcription request timed out')
  })

  it('times out while waiting for a slow response body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise(() => undefined)
          })
        )
      )
    )
    const session = new DeepgramTranscriptionSession('deepgram-nova-3', () => 'dg-secret')
    session.feedAudio(new Float32Array([0]), 16_000)

    let outcome: unknown
    void session.finish().then(
      () => {
        outcome = 'resolved'
      },
      (error: unknown) => {
        outcome = error
      }
    )
    await vi.advanceTimersByTimeAsync(60_000)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('Deepgram transcription request timed out')
  })

  it('rejects a response larger than the allowed byte limit', async () => {
    const oversizedTranscript = 'a'.repeat(1_000_001)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: { channels: [{ alternatives: [{ transcript: oversizedTranscript }] }] }
          })
        )
      )
    )
    const session = new DeepgramTranscriptionSession('deepgram-nova-3', () => 'dg-secret')
    session.feedAudio(new Float32Array([0]), 16_000)

    await expect(session.finish()).rejects.toThrow('Deepgram transcription response was too large')
  })
})
