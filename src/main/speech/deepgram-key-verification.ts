import type { CloudSpeechKeyTestResult } from '../../shared/cloud-speech-providers'
import { CLOUD_TRANSCRIPTION_SAMPLE_RATE } from './cloud-speech-session'
import { DEEPGRAM_REALTIME_URL, readDeepgramError } from './deepgram-realtime-session'
import { describeRejectedKey, runWebSocketKeyProbe } from './websocket-key-probe'

const LABEL = 'Deepgram'
const PROBE_MODEL = 'nova-3'
// 100 ms of 16-bit mono silence: enough for Deepgram to run the stream and answer.
const PROBE_SILENCE_BYTES = (CLOUD_TRANSCRIPTION_SAMPLE_RATE / 10) * 2
const NORMAL_CLOSURE = 1000
const CONFIRMING_FRAME_TYPES = new Set(['Results', 'Metadata'])

function buildProbeUrl(): URL {
  const url = new URL(DEEPGRAM_REALTIME_URL)
  url.searchParams.set('model', PROBE_MODEL)
  url.searchParams.set('encoding', 'linear16')
  url.searchParams.set('sample_rate', String(CLOUD_TRANSCRIPTION_SAMPLE_RATE))
  url.searchParams.set('channels', '1')
  return url
}

function readProbeFrame(raw: string): CloudSpeechKeyTestResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const frame: Record<string, unknown> = Object.fromEntries(Object.entries(parsed))
  const error = readDeepgramError(frame)
  if (error !== null) {
    return { ok: false, message: `${LABEL} returned an error. ${error}` }
  }
  const confirmed = typeof frame.type === 'string' && CONFIRMING_FRAME_TYPES.has(frame.type)
  return confirmed ? { ok: true, message: null } : null
}

/**
 * Verifies a Deepgram key on the live endpoint dictation uses: a project-listing probe
 * passes for keys scoped away from transcription, so only a real stream proves the key.
 */
export function verifyDeepgramApiKey(
  apiKey: string,
  timeoutMs: number
): Promise<CloudSpeechKeyTestResult> {
  let streamed = false
  return runWebSocketKeyProbe({
    label: LABEL,
    url: buildProbeUrl(),
    headers: { Authorization: `Token ${apiKey}` },
    apiKey,
    timeoutMs,
    sendProbe: (socket) => {
      socket.send(Buffer.alloc(PROBE_SILENCE_BYTES))
      // Why: CloseStream makes Deepgram flush and close cleanly, so the probe ends within a second.
      socket.send(JSON.stringify({ type: 'CloseStream' }))
      streamed = true
    },
    readFrame: readProbeFrame,
    describeRefusedHandshake: (status) =>
      status === 401 || status === 403
        ? describeRejectedKey(LABEL, status)
        : `${LABEL} refused the streaming connection (${status}).`,
    readClose: (code) => (streamed && code === NORMAL_CLOSURE ? { ok: true, message: null } : null)
  })
}
