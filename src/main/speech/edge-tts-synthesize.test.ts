import { afterEach, describe, expect, it } from 'vitest'
import { EDGE_SPEECH_CANCELLED_MESSAGE } from '../../shared/native-chat/native-chat-speech'
import {
  cancelEdgeSpeech,
  edgeSpeechRate,
  escapeEdgeSpeechText,
  parseEdgeSpeechRequest,
  readEdgeBinaryAudio,
  synthesizeEdgeSpeech,
  type EdgeSpeechHandlers,
  type EdgeSpeechSocket
} from './edge-tts-synthesize'

class FakeSocket implements EdgeSpeechSocket {
  private handlers: EdgeSpeechHandlers | null = null

  send(): void {}

  close(): void {
    this.handlers?.close()
  }

  subscribe(handlers: EdgeSpeechHandlers): void {
    this.handlers = handlers
  }

  endTurn(): void {
    this.handlers?.message('Path:turn.end', false)
  }

  audio(payload: Buffer): void {
    this.handlers?.message(payload, true)
  }
}

afterEach(() => {
  cancelEdgeSpeech()
})

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
    const message = Buffer.alloc(2 + header.length + audio.length)
    message.writeUInt16BE(header.length, 0)
    header.copy(message, 2)
    audio.copy(message, 2 + header.length)
    expect(readEdgeBinaryAudio(message)).toEqual(audio)
    expect(readEdgeBinaryAudio(Buffer.from([0, 1]))).toBeNull()
  })
})

function audioFrame(audio: Buffer): Buffer {
  const header = Buffer.from('Path:audio\r\nContent-Type:audio/mpeg\r\n')
  const message = Buffer.alloc(2 + header.length + audio.length)
  message.writeUInt16BE(header.length, 0)
  header.copy(message, 2)
  audio.copy(message, 2 + header.length)
  return message
}

describe('Edge speech cancellation', () => {
  it('does not start the next chunk after stop, even if turn.end arrives late', async () => {
    const opened: FakeSocket[] = []
    const pending = synthesizeEdgeSpeech(
      {
        text: 'а'.repeat(3_001),
        voice: 'ru-RU-SvetlanaNeural',
        rate: 1
      },
      () => {
        const socket = new FakeSocket()
        opened.push(socket)
        return socket
      }
    )
    const rejected = expect(pending).rejects.toThrow(EDGE_SPEECH_CANCELLED_MESSAGE)
    expect(opened).toHaveLength(1)
    cancelEdgeSpeech()
    opened[0]?.endTurn()
    await rejected
    expect(opened).toHaveLength(1)
  })

  it('returns the mpeg bytes that start immediately after the header', async () => {
    const audio = Buffer.from([0xff, 0xfb, 0x90, 0x64])
    const opened: FakeSocket[] = []
    const pending = synthesizeEdgeSpeech(
      { text: 'Привет', voice: 'ru-RU-SvetlanaNeural', rate: 1 },
      () => {
        const socket = new FakeSocket()
        opened.push(socket)
        return socket
      }
    )
    opened[0]?.audio(audioFrame(audio))
    opened[0]?.endTurn()
    await expect(pending).resolves.toEqual({ audioBase64: audio.toString('base64') })
  })

  it('reports a dropped socket separately from stop', async () => {
    const opened: FakeSocket[] = []
    const pending = synthesizeEdgeSpeech(
      { text: 'Привет', voice: 'ru-RU-SvetlanaNeural', rate: 1 },
      () => {
        const socket = new FakeSocket()
        opened.push(socket)
        return socket
      }
    )
    const rejected = expect(pending).rejects.toThrow('Edge speech connection closed')
    opened[0]?.close()
    await rejected
  })
})
