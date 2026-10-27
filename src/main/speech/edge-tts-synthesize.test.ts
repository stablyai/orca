import { describe, expect, it } from 'vitest'
import {
  edgeSpeechRate,
  escapeEdgeSpeechText,
  parseEdgeSpeechRequest,
  readEdgeBinaryAudio
} from './edge-tts-synthesize'

describe('Edge speech messages', () => {
  it('rejects an empty or unknown request before opening a socket', () => {
    expect(() => parseEdgeSpeechRequest({ text: '   ', voice: 'ru-RU-SvetlanaNeural' })).toThrow(
      'Nothing to speak'
    )
    expect(() => parseEdgeSpeechRequest({ text: 'Привет', voice: 'en-US-AriaNeural' })).toThrow(
      'Unknown speech voice'
    )
  })

  it('clamps the rate and escapes text that would break SSML', () => {
    expect(
      parseEdgeSpeechRequest({ text: 'Привет', voice: 'ru-RU-DmitryNeural', rate: 4 }).rate
    ).toBe(2)
    expect(edgeSpeechRate(0.8)).toBe('-20%')
    expect(edgeSpeechRate(1)).toBe('+0%')
    expect(escapeEdgeSpeechText('API & <TypeScript>')).toBe('API &amp; &lt;TypeScript&gt;')
  })

  it('reads mpeg bytes that follow the binary header', () => {
    const header = Buffer.from('Path:audio\r\nContent-Type:audio/mpeg\r\n')
    const audio = Buffer.from([1, 2, 3, 4])
    const message = Buffer.alloc(2 + header.length + 2 + audio.length)
    message.writeUInt16BE(header.length, 0)
    header.copy(message, 2)
    audio.copy(message, 2 + header.length + 2)
    expect(readEdgeBinaryAudio(message)).toEqual(audio)
    expect(readEdgeBinaryAudio(Buffer.from([0, 1]))).toBeNull()
  })
})
