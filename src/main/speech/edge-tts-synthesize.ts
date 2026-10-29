import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import {
  chunkNativeChatSpeech,
  type NativeChatEdgeSpeechRequest
} from '../../shared/native-chat-speech'
import { edgeTtsWebSocketUrl } from './edge-tts-token'

const VOICES = new Set(['ru-RU-SvetlanaNeural', 'ru-RU-DmitryNeural'])
const MAX_TEXT_LENGTH = 20_000
const CHUNK_LIMIT = 3_000
const SOCKET_TIMEOUT_MS = 20_000

const SOCKET_HEADERS = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
}

let activeSocket: WebSocket | null = null

export function cancelEdgeSpeech(): void {
  activeSocket?.close()
  activeSocket = null
}

export function parseEdgeSpeechRequest(request: unknown): NativeChatEdgeSpeechRequest {
  if (!request || typeof request !== 'object') {
    throw new Error('Speech request is invalid')
  }
  const record = request as { text?: unknown; voice?: unknown; rate?: unknown }
  if (typeof record.text !== 'string' || record.text.trim().length === 0) {
    throw new Error('Nothing to speak')
  }
  if (record.text.length > MAX_TEXT_LENGTH) {
    throw new Error('That reply is too long to speak')
  }
  if (typeof record.voice !== 'string' || !VOICES.has(record.voice)) {
    throw new Error('Unknown speech voice')
  }
  const rate =
    typeof record.rate === 'number' && Number.isFinite(record.rate)
      ? Math.min(2, Math.max(0.5, record.rate))
      : 1
  return { text: record.text, voice: record.voice as NativeChatEdgeSpeechRequest['voice'], rate }
}

export function edgeSpeechRate(rate: number): string {
  const percent = Math.round((rate - 1) * 100)
  return `${percent >= 0 ? '+' : ''}${percent}%`
}

export function escapeEdgeSpeechText(text: string): string {
  let cleaned = ''
  for (const character of text) {
    const code = character.charCodeAt(0)
    cleaned += code < 32 && code !== 9 && code !== 10 && code !== 13 ? ' ' : character
  }
  return cleaned
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function edgeSpeechTimestamp(date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
}

export function readEdgeBinaryAudio(message: Buffer): Buffer | null {
  if (message.length < 2) {
    return null
  }
  const headerLength = message.readUInt16BE(0)
  if (headerLength > message.length - 2) {
    return null
  }
  const header = message.subarray(2, 2 + headerLength).toString('utf8')
  if (!header.includes('Path:audio') || !header.includes('audio/mpeg')) {
    return null
  }
  const audio = message.subarray(2 + headerLength + 2)
  return audio.length > 0 ? audio : null
}

function edgeSsml(text: string, voice: string, rate: number): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'>" +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='${edgeSpeechRate(rate)}' volume='+0%'>` +
    `${escapeEdgeSpeechText(text)}</prosody></voice></speak>`
  )
}

function bufferFromSocketMessage(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data)
  }
  return Buffer.from(data)
}

function synthesizeChunk(text: string, voice: string, rate: number): Promise<Buffer> {
  cancelEdgeSpeech()
  const socket = new WebSocket(edgeTtsWebSocketUrl(randomUUID().replaceAll('-', '')), {
    headers: {
      ...SOCKET_HEADERS,
      Cookie: `muid=${randomUUID().replaceAll('-', '').toUpperCase()};`
    },
    handshakeTimeout: 10_000
  })
  activeSocket = socket
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    let completed = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: Error | null, audio?: Buffer): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (activeSocket === socket) {
        activeSocket = null
      }
      if (error) {
        reject(error)
        return
      }
      resolve(audio ?? Buffer.alloc(0))
    }
    const fail = (error: Error): void => finish(error)
    timer = setTimeout(() => {
      timedOut = true
      socket.close()
      fail(new Error('Edge speech timed out'))
    }, SOCKET_TIMEOUT_MS)
    socket.on('error', () => fail(new Error('Edge speech connection failed')))
    socket.on('close', () => {
      if (!completed && !timedOut) {
        fail(new Error('Edge speech was cancelled'))
      }
    })
    socket.on('unexpected-response', (request, response) => {
      // ws keeps the handshake open once this listener exists. Drain it or each refusal leaks.
      response.resume()
      request.destroy()
      fail(new Error(`Edge speech refused the connection (${response.statusCode ?? 'unknown'})`))
    })
    socket.on('open', () => {
      const timestamp = edgeSpeechTimestamp()
      socket.send(
        `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
      )
      socket.send(
        `X-RequestId:${randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${edgeSsml(text, voice, rate)}`
      )
    })
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (String(data).includes('Path:turn.end')) {
          completed = true
          socket.close()
          if (chunks.length === 0) {
            fail(new Error('Edge speech returned no audio'))
            return
          }
          finish(null, Buffer.concat(chunks))
        }
        return
      }
      const audio = readEdgeBinaryAudio(bufferFromSocketMessage(data))
      if (audio) {
        chunks.push(audio)
      }
    })
  })
}

export async function synthesizeEdgeSpeech(request: unknown): Promise<{ audioBase64: string }> {
  const parsed = parseEdgeSpeechRequest(request)
  const parts: Buffer[] = []
  for (const chunk of chunkNativeChatSpeech(parsed.text, CHUNK_LIMIT)) {
    parts.push(await synthesizeChunk(chunk, parsed.voice, parsed.rate))
  }
  return { audioBase64: Buffer.concat(parts).toString('base64') }
}
