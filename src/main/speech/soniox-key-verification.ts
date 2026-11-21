import type { ClientRequest, IncomingMessage } from 'node:http'
import { CLOUD_TRANSCRIPTION_SAMPLE_RATE } from '../../shared/speech/dictation/dictation-finish-deadlines'
import { saveSonioxSpeechApiKey } from './soniox-api-key-store'
import {
  openSonioxSocket,
  parseSonioxFrame,
  readSonioxError,
  SONIOX_REALTIME_URL,
  SONIOX_REFUSED_KEY_STATUSES,
  sonioxKeyRefusalMessage,
  sonioxStreamConfig,
  type OpenSonioxSocket,
  type SonioxSocket
} from './soniox-protocol'
import { sanitizeOpenAiTranscriptionErrorMessage } from './openai-transcription-client'

const KEY_CHECK_TIMEOUT_MS = 10_000
// 100 ms of silence: enough for Soniox to run the stream and answer `finished`.
const PROBE_SILENCE_BYTES = (CLOUD_TRANSCRIPTION_SAMPLE_RATE / 10) * 2
const REFUSED_ERROR_TYPES = new Set(['unauthenticated', 'permission_denied'])

/** null: the key works, or the check couldn't tell (offline, timeout); otherwise why Soniox refused it. */
export function checkSonioxApiKey(
  apiKey: string,
  openSocket: OpenSonioxSocket = openSonioxSocket,
  timeoutMs = KEY_CHECK_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: SonioxSocket | null = null
    const timer = setTimeout(() => settle(null), timeoutMs)
    timer.unref?.()

    function settle(refusal: string | null): void {
      clearTimeout(timer)
      if (socket) {
        socket.removeAllListeners()
        socket.on('error', () => undefined)
        socket.terminate()
        socket = null
      }
      resolve(refusal === null ? null : sanitizeOpenAiTranscriptionErrorMessage(refusal, apiKey))
    }

    try {
      socket = openSocket(SONIOX_REALTIME_URL, apiKey)
    } catch {
      settle(null)
      return
    }
    const opened = socket
    // The same stream dictation opens, since Soniox scopes key permissions per API.
    opened.on('open', () => {
      opened.send(JSON.stringify(sonioxStreamConfig(undefined)))
      opened.send(Buffer.alloc(PROBE_SILENCE_BYTES))
      opened.send('')
    })
    opened.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        return
      }
      const frame = parseSonioxFrame(data.toString())
      if (!frame) {
        return
      }
      const error = readSonioxError(frame)
      if (error) {
        const refused =
          (typeof frame.error_code === 'number' &&
            SONIOX_REFUSED_KEY_STATUSES.has(frame.error_code)) ||
          (typeof frame.error_type === 'string' && REFUSED_ERROR_TYPES.has(frame.error_type))
        settle(refused ? error : null)
      } else if (frame.finished === true) {
        settle(null)
      }
    })
    opened.on('unexpected-response', (request: ClientRequest, response: IncomingMessage) => {
      request.destroy()
      const status = response.statusCode ?? 0
      settle(SONIOX_REFUSED_KEY_STATUSES.has(status) ? sonioxKeyRefusalMessage(status) : null)
    })
    opened.on('error', () => settle(null))
    opened.on('close', () => settle(null))
  })
}

/** Refuses keys Soniox rejects; offline or other failures still save, like the OpenAI key. */
export async function saveVerifiedSonioxSpeechApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()
  if (trimmed) {
    const refusal = await checkSonioxApiKey(trimmed)
    if (refusal) {
      throw new Error(refusal)
    }
  }
  await saveSonioxSpeechApiKey(apiKey)
}
