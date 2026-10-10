import type { CloudSpeechKeyTestResult } from '../../shared/cloud-speech-providers'
import { CLOUD_TRANSCRIPTION_SAMPLE_RATE } from './cloud-speech-session'
import { SONIOX_REALTIME_API_MODEL } from './cloud-speech-model-catalog'
import { buildSonioxStreamConfig, SONIOX_REALTIME_URL } from './soniox-realtime-session'
import { runWebSocketKeyProbe } from './websocket-key-probe'

const LABEL = 'Soniox'
// 100 ms of 16-bit mono silence: enough for Soniox to run the session and send `finished`.
const PROBE_SILENCE_BYTES = (CLOUD_TRANSCRIPTION_SAMPLE_RATE / 10) * 2
const REJECTED_ERROR_TYPES = new Set(['unauthenticated', 'permission_denied'])

type SonioxErrorFrame = { code: number | null; type: string | null; message: string }

function readProbeFrame(raw: string): SonioxErrorFrame | 'finished' | null {
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
  const { error_code: code, error_type: type, error_message: message } = frame
  if (code !== undefined || typeof message === 'string') {
    return {
      code: typeof code === 'number' ? code : null,
      type: typeof type === 'string' ? type : null,
      message: typeof message === 'string' ? message : ''
    }
  }
  return frame.finished === true ? 'finished' : null
}

function describeErrorFrame(frame: SonioxErrorFrame): string {
  const status = frame.code === null ? '' : ` (${frame.code})`
  const rejected =
    frame.code === 401 ||
    frame.code === 403 ||
    (frame.type !== null && REJECTED_ERROR_TYPES.has(frame.type))
  if (!rejected) {
    return `${LABEL} returned an error${status}. ${frame.message}`
  }
  // Why: 403 often means billing or permissions on a valid key, so it is worded apart from 401.
  const deniedAccess = frame.code === 403 || frame.type === 'permission_denied'
  return `${LABEL} ${deniedAccess ? 'denied access for' : 'rejected'} this API key${status}. ${frame.message}`
}

/**
 * Verifies a Soniox key on the real-time STT endpoint dictation uses: Soniox scopes
 * permissions per API, so a model-listing probe can pass for a key dictation cannot use.
 */
export function verifySonioxApiKey(
  apiKey: string,
  timeoutMs: number
): Promise<CloudSpeechKeyTestResult> {
  return runWebSocketKeyProbe({
    label: LABEL,
    url: SONIOX_REALTIME_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
    apiKey,
    timeoutMs,
    sendProbe: (socket) => {
      socket.send(JSON.stringify(buildSonioxStreamConfig(SONIOX_REALTIME_API_MODEL)))
      socket.send(Buffer.alloc(PROBE_SILENCE_BYTES))
      // Why: an empty text frame ends the audio, so Soniox answers `finished` within a second.
      socket.send('')
    },
    readFrame: (raw) => {
      const frame = readProbeFrame(raw)
      if (frame === 'finished') {
        return { ok: true, message: null }
      }
      return frame ? { ok: false, message: describeErrorFrame(frame) } : null
    },
    describeRefusedHandshake: (status) =>
      describeErrorFrame({ code: status, type: null, message: '' })
  })
}
