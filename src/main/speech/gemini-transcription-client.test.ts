import { describe, expect, it, vi } from 'vitest'
import { createCloudSpeechSession } from './cloud-speech-session-factory'
import { readGeminiTranscript } from './gemini-transcription-client'
import { getCatalogModel } from './model-catalog'

describe('readGeminiTranscript', () => {
  it('reads text and audioTranscription parts', () => {
    expect(
      readGeminiTranscript({
        candidates: [
          { content: { parts: [{ text: 'Hello ' }, { audioTranscription: { text: 'there' } }] } }
        ]
      })
    ).toBe('Hello there')
  })

  it('keeps silence as an empty transcript', () => {
    expect(readGeminiTranscript({ candidates: [{ content: { parts: [{ text: '""' }] } }] })).toBe(
      ''
    )
    expect(readGeminiTranscript({ candidates: [{ finishReason: 'STOP' }] })).toBe('')
    expect(
      readGeminiTranscript({ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] })
    ).toBe('')
    expect(readGeminiTranscript({ candidates: [{ content: { parts: [{ text: '' }] } }] })).toBe('')
  })

  it('rejects parts that carry no text field instead of reading them as silence', () => {
    for (const parts of [[{}], [{ audioTranscription: {} }], [{}, { audioTranscription: {} }]]) {
      expect(() =>
        readGeminiTranscript({ candidates: [{ finishReason: 'STOP', content: { parts } }] })
      ).toThrow('Gemini returned an invalid transcription response')
    }
  })

  it('ignores thought parts', () => {
    expect(
      readGeminiTranscript({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: 'Thinking about audio', thought: true }, { text: 'Hi.' }] }
          }
        ]
      })
    ).toBe('Hi.')
    expect(
      readGeminiTranscript({
        candidates: [
          { finishReason: 'STOP', content: { parts: [{ text: 'Plan', thought: true }] } }
        ]
      })
    ).toBe('')
  })

  it('reports a blocked prompt instead of silence', () => {
    expect(() => readGeminiTranscript({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow(
      'Gemini blocked the request (SAFETY).'
    )
  })

  it('reports a candidate without content and its finish reason', () => {
    expect(() =>
      readGeminiTranscript({ candidates: [{ finishReason: 'RECITATION', content: {} }] })
    ).toThrow('Gemini returned no transcript (RECITATION).')
    expect(() => readGeminiTranscript({})).toThrow('Gemini returned no transcript.')
  })

  it.each(['MAX_TOKENS', 'SAFETY', 'RECITATION'])(
    'rejects partial text cut short by %s instead of returning it as the transcript',
    (finishReason) => {
      expect(() =>
        readGeminiTranscript({
          candidates: [{ finishReason, content: { parts: [{ text: 'Hello, this is the fi' }] } }]
        })
      ).toThrow(`Gemini did not complete the transcription (${finishReason}).`)
    }
  )

  it('keeps text whose candidate has no finish reason', () => {
    expect(readGeminiTranscript({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] })).toBe(
      'Hi'
    )
  })
})

describe('Gemini batch session', () => {
  it('refuses audio past 7 minutes so the inline request stays under the size cap', () => {
    const manifest = getCatalogModel('gemini-2.5-flash')
    if (!manifest) {
      throw new Error('missing gemini-2.5-flash')
    }
    const session = createCloudSpeechSession(manifest, { readApiKey: () => 'key', sink: vi.fn() })

    session.feedAudio(new Float32Array(8_000 * 60 * 6), 8_000)
    expect(() => session.feedAudio(new Float32Array(8_000 * 61), 8_000)).toThrow(
      'Gemini dictation is limited to 7 minutes per recording.'
    )
    session.cancel()
  })
})
