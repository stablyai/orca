import { wavBlob, type BatchTranscribe } from './batch-cloud-speech-session'
import { assertProviderResponseOk } from './cloud-speech-provider-errors'
import {
  readTranscriptionJson,
  TEXT_TRANSCRIPTION_RESPONSE
} from './cloud-speech-transcription-response'

export const MISTRAL_API_BASE_URL = 'https://api.mistral.ai'

/** Mistral Voxtral batch transcription (OpenAI-like multipart, different auth header). */
export function createMistralTranscribe(apiModel: string): BatchTranscribe {
  return async ({ wav, apiKey, language, signal }) => {
    const form = new FormData()
    form.append('model', apiModel)
    if (language) {
      form.append('language', language)
    }
    form.append('file', wavBlob(wav), 'dictation.wav')
    const response = await fetch(`${MISTRAL_API_BASE_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      // Why: Mistral's audio docs use x-api-key while the rest of the API takes Bearer; send both.
      headers: { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}` },
      body: form,
      signal
    })
    await assertProviderResponseOk('Mistral', response)
    const data = await readTranscriptionJson('Mistral', response, TEXT_TRANSCRIPTION_RESPONSE)
    return data.text
  }
}
