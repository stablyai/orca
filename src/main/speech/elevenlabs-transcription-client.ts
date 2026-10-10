import { wavBlob, type BatchTranscribe } from './batch-cloud-speech-session'
import { assertProviderResponseOk } from './cloud-speech-provider-errors'
import {
  readTranscriptionJson,
  TEXT_TRANSCRIPTION_RESPONSE
} from './cloud-speech-transcription-response'

export const ELEVENLABS_API_BASE_URL = 'https://api.elevenlabs.io'

/** ElevenLabs Scribe batch: one multipart upload per dictation. */
export function createElevenLabsTranscribe(apiModel: string): BatchTranscribe {
  return async ({ wav, apiKey, language, signal }) => {
    const form = new FormData()
    form.append('model_id', apiModel)
    form.append('temperature', '0')
    form.append('tag_audio_events', 'false')
    if (language) {
      form.append('language_code', language)
    }
    form.append('file', wavBlob(wav), 'dictation.wav')
    const response = await fetch(`${ELEVENLABS_API_BASE_URL}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      body: form,
      signal
    })
    await assertProviderResponseOk('ElevenLabs', response)
    const data = await readTranscriptionJson('ElevenLabs', response, TEXT_TRANSCRIPTION_RESPONSE)
    return data.text
  }
}
