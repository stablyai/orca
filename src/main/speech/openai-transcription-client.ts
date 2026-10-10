import { z } from 'zod'
import {
  BatchCloudSpeechSession,
  wavBlob,
  type BatchTranscribe
} from './batch-cloud-speech-session'
import { getCloudSpeechApiModel } from './cloud-speech-model-catalog'
import { readProviderErrorMessage, redactCloudSpeechSecrets } from './cloud-speech-provider-errors'
import {
  invalidTranscriptionResponse,
  readTranscriptionJson
} from './cloud-speech-transcription-response'

export const OPENAI_API_BASE_URL = 'https://api.openai.com'
export const GROQ_API_BASE_URL = 'https://api.groq.com/openai'

const OPENAI_TRANSCRIPTION_RESPONSE = z.object({
  text: z.string().optional(),
  error: z.object({ message: z.string().optional() }).optional()
})

export function sanitizeOpenAiTranscriptionErrorMessage(label: string, message: string): string {
  // Why: this phrasing echoes part of the key and is shared by OpenAI-compatible hosts such as Groq.
  if (/incorrect api key provided:/i.test(message)) {
    return `Incorrect ${label} API key provided.`
  }
  return redactCloudSpeechSecrets(message) || `${label} transcription request failed`
}

function parseOpenAiTranscriptionResponse(
  label: string,
  data: z.infer<typeof OPENAI_TRANSCRIPTION_RESPONSE>
): string {
  if (data.text !== undefined) {
    return data.text.trim()
  }
  if (data.error?.message !== undefined) {
    throw new Error(sanitizeOpenAiTranscriptionErrorMessage(label, data.error.message))
  }
  throw invalidTranscriptionResponse(label)
}

/** Multipart `/v1/audio/transcriptions` call shared by OpenAI and OpenAI-compatible hosts. */
export function createOpenAiCompatibleTranscribe(options: {
  label: string
  baseUrl: string
  apiModel: string
}): BatchTranscribe {
  return async ({ wav, apiKey, language, signal }) => {
    const form = new FormData()
    form.append('model', options.apiModel)
    form.append('response_format', 'json')
    form.append('temperature', '0')
    if (language) {
      // Why: gpt-transcribe takes a list of expected languages and rejects the singular field.
      form.append(options.apiModel === 'gpt-transcribe' ? 'languages[]' : 'language', language)
    }
    // Why: a named WAV blob avoids filesystem temp files and works in packaged apps.
    form.append('file', wavBlob(wav), 'dictation.wav')

    const response = await fetch(`${options.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal
    })
    if (!response.ok) {
      const message = sanitizeOpenAiTranscriptionErrorMessage(
        options.label,
        await readProviderErrorMessage(response)
      )
      throw new Error(`${options.label} transcription failed: ${message}`)
    }
    const data = await readTranscriptionJson(options.label, response, OPENAI_TRANSCRIPTION_RESPONSE)
    return parseOpenAiTranscriptionResponse(options.label, data)
  }
}

function requireApiModel(modelId: string, label: string): string {
  const apiModel = getCloudSpeechApiModel(modelId)
  if (!apiModel) {
    throw new Error(`Unknown ${label} transcription model: ${modelId}`)
  }
  return apiModel
}

export class OpenAiTranscriptionSession extends BatchCloudSpeechSession {
  constructor(modelId: string, readApiKey: () => string, options: { language?: string } = {}) {
    super(
      'OpenAI',
      createOpenAiCompatibleTranscribe({
        label: 'OpenAI',
        baseUrl: OPENAI_API_BASE_URL,
        apiModel: requireApiModel(modelId, 'OpenAI')
      }),
      readApiKey,
      options.language
    )
  }
}
