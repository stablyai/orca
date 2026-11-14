import { randomUUID } from 'node:crypto'
import {
  chunkNativeChatSpeech,
  EDGE_SPEECH_CANCELLED_MESSAGE,
  type NativeChatEdgeSpeechRequest
} from '../../shared/native-chat/native-chat-speech'
import { openEdgeSpeechSocket, type EdgeSpeechSocket } from './edge-speech-socket'
import { edgeTtsWebSocketUrl } from './edge-tts-token'

const MAX_TEXT_LENGTH = 20_000
const CHUNK_LIMIT = 3_000
const SOCKET_TIMEOUT_MS = 20_000

export type { EdgeSpeechHandlers, EdgeSpeechSocket } from './edge-speech-socket'

type EdgeSpeechJob = {
  cancelled: boolean
  socket: EdgeSpeechSocket | null
  fail: ((error: Error) => void) | null
}

let activeJob: EdgeSpeechJob | null = null

export function cancelEdgeSpeech(): void {
  const job = activeJob
  if (!job || job.cancelled) {
    return
  }
  // A later turn.end must not resolve this job or let the next chunk open a socket.
  job.cancelled = true
  const socket = job.socket
  job.socket = null
  socket?.close()
  job.fail?.(new Error(EDGE_SPEECH_CANCELLED_MESSAGE))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEdgeVoice(value: unknown): value is NativeChatEdgeSpeechRequest['voice'] {
  return value === 'ru-RU-SvetlanaNeural' || value === 'ru-RU-DmitryNeural'
}

export function parseEdgeSpeechRequest(request: unknown): NativeChatEdgeSpeechRequest {
  if (!isRecord(request)) {
    throw new Error('Speech request is invalid')
  }
  const text = request.text
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Nothing to speak')
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new Error('That reply is too long to speak')
  }
  if (!isEdgeVoice(request.voice)) {
    throw new Error('Unknown speech voice')
  }
  const rateValue = request.rate
  const rate =
    typeof rateValue === 'number' && Number.isFinite(rateValue)
      ? Math.min(2, Math.max(0.5, rateValue))
      : 1
  return { text, voice: request.voice, rate }
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
  // The 2-byte length is already consumed. Skipping two more bytes drops the MP3 frame sync.
  const audio = message.subarray(2 + headerLength)
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

function bufferFromSocketMessage(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }
  if (!Array.isArray(data)) {
    return null
  }
  const parts: Buffer[] = []
  for (const part of data) {
    if (!Buffer.isBuffer(part)) {
      return null
    }
    parts.push(part)
  }
  return Buffer.concat(parts)
}

function synthesizeChunk(
  text: string,
  voice: string,
  rate: number,
  job: EdgeSpeechJob,
  openSocket: (url: string) => EdgeSpeechSocket
): Promise<Buffer> {
  if (job.cancelled) {
    return Promise.reject(new Error(EDGE_SPEECH_CANCELLED_MESSAGE))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    let completed = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let socket: EdgeSpeechSocket | null = null
    const finish = (error: Error | null, audio?: Buffer): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (job.fail === rejectWith) {
        job.fail = null
      }
      if (socket && job.socket === socket) {
        job.socket = null
      }
      if (error) {
        reject(error)
        return
      }
      resolve(audio ?? Buffer.alloc(0))
    }
    const rejectWith = (error: Error): void => finish(error)
    // Arm the job before connect so a stop during open rejects this chunk and closes its socket.
    job.fail = rejectWith
    socket = openSocket(edgeTtsWebSocketUrl(randomUUID().replaceAll('-', '')))
    job.socket = socket
    if (job.cancelled) {
      socket.close()
      rejectWith(new Error(EDGE_SPEECH_CANCELLED_MESSAGE))
      return
    }
    const connected = socket
    timer = setTimeout(() => {
      timedOut = true
      connected.close()
      rejectWith(new Error('Edge speech timed out'))
    }, SOCKET_TIMEOUT_MS)
    connected.subscribe({
      open: () => {
        const timestamp = edgeSpeechTimestamp()
        connected.send(
          `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
        )
        connected.send(
          `X-RequestId:${randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${edgeSsml(text, voice, rate)}`
        )
      },
      error: () => {
        rejectWith(new Error('Edge speech connection failed'))
        connected.close()
      },
      close: () => {
        if (job.cancelled) {
          rejectWith(new Error(EDGE_SPEECH_CANCELLED_MESSAGE))
          return
        }
        if (!completed && !timedOut) {
          rejectWith(new Error('Edge speech connection closed'))
        }
      },
      unexpectedResponse: (request, response) => {
        // ws keeps the handshake open once this listener exists. Drain it or each refusal leaks.
        // Settle first: destroy can emit close, and that close is not a user stop or a dropped socket.
        response.resume()
        rejectWith(
          new Error(`Edge speech refused the connection (${response.statusCode ?? 'unknown'})`)
        )
        request.destroy()
      },
      message: (data, isBinary) => {
        if (job.cancelled) {
          return
        }
        if (!isBinary) {
          if (String(data).includes('Path:turn.end')) {
            completed = true
            connected.close()
            if (chunks.length === 0) {
              rejectWith(new Error('Edge speech returned no audio'))
              return
            }
            finish(null, Buffer.concat(chunks))
          }
          return
        }
        const audio = bufferFromSocketMessage(data)
        const mpeg = audio ? readEdgeBinaryAudio(audio) : null
        if (mpeg) {
          chunks.push(mpeg)
        }
      }
    })
  })
}

export async function synthesizeEdgeSpeech(
  request: unknown,
  openSocket: (url: string) => EdgeSpeechSocket = openEdgeSpeechSocket
): Promise<{ audioBase64: string }> {
  const parsed = parseEdgeSpeechRequest(request)
  cancelEdgeSpeech()
  const job: EdgeSpeechJob = { cancelled: false, socket: null, fail: null }
  activeJob = job
  try {
    const parts: Buffer[] = []
    for (const chunk of chunkNativeChatSpeech(parsed.text, CHUNK_LIMIT)) {
      if (job.cancelled) {
        throw new Error(EDGE_SPEECH_CANCELLED_MESSAGE)
      }
      parts.push(await synthesizeChunk(chunk, parsed.voice, parsed.rate, job, openSocket))
    }
    return { audioBase64: Buffer.concat(parts).toString('base64') }
  } finally {
    if (activeJob === job) {
      activeJob = null
    }
  }
}
