import { wavBlob } from './batch-cloud-speech-session'
import { encodePcm16Wav } from './cloud-speech-audio-encoding'
import { CLOUD_TRANSCRIPTION_SAMPLE_RATE } from './cloud-speech-session'
import { OPENAI_API_BASE_URL } from './openai-transcription-client'

export const OPENAI_KEY_PROBE_URL = `${OPENAI_API_BASE_URL}/v1/audio/transcriptions`
const OPENAI_KEY_PROBE_MODEL = 'gpt-4o-mini-transcribe'
// OpenAI's documented code for a clip under its 0.1 s minimum.
const AUDIO_TOO_SHORT_CODE = 'audio_too_short'

/** 100 ms of 16 kHz silence: the cheapest upload the transcription endpoint will accept. */
export function buildOpenAiKeyProbeForm(): FormData {
  const silence = new Float32Array(CLOUD_TRANSCRIPTION_SAMPLE_RATE / 10)
  const form = new FormData()
  form.append('model', OPENAI_KEY_PROBE_MODEL)
  form.append('response_format', 'json')
  form.append(
    'file',
    wavBlob(encodePcm16Wav(silence, CLOUD_TRANSCRIPTION_SAMPLE_RATE)),
    'probe.wav'
  )
  return form
}

function readOpenAiError(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }
  const error: unknown = Object.fromEntries(Object.entries(body)).error
  return error && typeof error === 'object' && !Array.isArray(error)
    ? Object.fromEntries(Object.entries(error))
    : null
}

/**
 * True when a 400 objects to the probe audio itself; OpenAI authenticates (401) and checks
 * scopes (401/403) before it validates the upload, so this still proves the key works.
 */
export async function isOpenAiProbeAudioRejection(response: Response): Promise<boolean> {
  if (response.status !== 400) {
    return false
  }
  let body: unknown
  try {
    body = JSON.parse(await response.text())
  } catch {
    return false
  }
  const error = readOpenAiError(body)
  return error?.code === AUDIO_TOO_SHORT_CODE || error?.param === 'file'
}
